/**
 * Compute `Token.trendingScore` for the active cohort.
 *
 * `scoreTrending` in @stunks/database has existed, with tests, since the schema was
 * written — and had no caller, so every row held the default 0 and the Explore
 * "Trending" tab degenerated to `id desc`, an arbitrary order shown as a ranking
 * (R41). This is the caller.
 *
 *   pnpm score:trending                  score with the default 24h window
 *   pnpm score:trending -- --window 48   compare two 48-hour windows instead
 *   pnpm score:trending -- --dry-run     rank and print, write nothing
 *
 * THE WINDOW IS ANCHORED TO THE DATA, NOT THE CLOCK.
 *
 * The score's largest component is volume acceleration: this window against the one
 * before it. Anchoring to `now()` would break the moment the indexer falls behind —
 * and on this deployment the curve stream has been a day or more behind, so a
 * wall-clock 24-hour window would contain no trades at all and every token would
 * score zero. The anchor is therefore the newest indexed trade. "Recent" means recent
 * in the data, and the site already reports how old that data is.
 *
 * Cohort membership: tokens with at least one trade in the recent window. A token
 * nobody has traded is not trending, and including it would only dilute the
 * normalisation denominators.
 */

import {
  DEFAULT_TRENDING_WEIGHTS,
  getPrisma,
  scoreTrending,
  type TrendingInput,
} from "@stunks/database";
import { ROBINHOOD_CHAIN_ID } from "@stunks/config";

/** Rows written per statement. Small enough to stay friendly on a pooled connection. */
const WRITE_CHUNK = 500;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  // eslint-disable-next-line no-restricted-syntax -- an hour count is not money
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`--${name} needs a positive number`);
    process.exit(1);
  }
  return parsed;
}

interface Row {
  tokenId: string;
  recentVolume: string;
  priorVolume: string;
  uniqueTraders: bigint;
  tradeCount: bigint;
  buyVolume: string;
  sellVolume: string;
  marketCap: string;
  priorMarketCap: string;
}

async function main(): Promise<void> {
  const dryRun = flag("dry-run");
  const windowHours = numberArg("window", 24);
  const prisma = getPrisma();
  const chainId = ROBINHOOD_CHAIN_ID;

  const anchorRows = await prisma.$queryRaw<{ anchor: Date | null }[]>`
    SELECT MAX(timestamp) AS anchor FROM trades WHERE "chainId" = ${chainId}`;
  const anchor = anchorRows[0]?.anchor;
  if (!anchor) {
    console.log("No indexed trades, so nothing to rank.");
    await prisma.$disconnect();
    return;
  }

  console.log(`window        : ${windowHours}h, anchored at the newest indexed trade`);
  console.log(`anchor        : ${anchor.toISOString()}`);
  const lagHours = (Date.now() - anchor.getTime()) / 3_600_000;
  if (lagHours > 1) {
    console.log(`data age      : ${lagHours.toFixed(1)}h behind the clock`);
  }

  // Both windows, plus the price at the start of the recent one for market-cap growth,
  // gathered in a single pass rather than a query per token.
  const rows = await prisma.$queryRaw<Row[]>`
    WITH bounds AS (
      SELECT ${anchor}::timestamptz AS hi,
             ${anchor}::timestamptz - (${windowHours} || ' hours')::interval AS mid,
             ${anchor}::timestamptz - (${windowHours} * 2 || ' hours')::interval AS lo
    ),
    recent AS (
      SELECT t."tokenId",
             SUM(t."quoteAmount") AS volume,
             COUNT(DISTINCT t."traderAddress") AS traders,
             COUNT(*) AS trades,
             SUM(t."quoteAmount") FILTER (WHERE t.side = 'BUY') AS buys,
             SUM(t."quoteAmount") FILTER (WHERE t.side = 'SELL') AS sells
      FROM trades t, bounds b
      WHERE t."chainId" = ${chainId} AND t.timestamp > b.mid AND t.timestamp <= b.hi
      GROUP BY t."tokenId"
    ),
    prior AS (
      SELECT t."tokenId", SUM(t."quoteAmount") AS volume
      FROM trades t, bounds b
      WHERE t."chainId" = ${chainId} AND t.timestamp > b.lo AND t.timestamp <= b.mid
      GROUP BY t."tokenId"
    ),
    prior_price AS (
      SELECT DISTINCT ON (t."tokenId") t."tokenId", t.price
      FROM trades t, bounds b
      WHERE t."chainId" = ${chainId} AND t.timestamp <= b.mid
      ORDER BY t."tokenId", t.timestamp DESC
    )
    SELECT r."tokenId"                                   AS "tokenId",
           r.volume::text                                AS "recentVolume",
           COALESCE(p.volume, 0)::text                   AS "priorVolume",
           r.traders                                     AS "uniqueTraders",
           r.trades                                      AS "tradeCount",
           COALESCE(r.buys, 0)::text                     AS "buyVolume",
           COALESCE(r.sells, 0)::text                    AS "sellVolume",
           tok."marketCap"::text                         AS "marketCap",
           COALESCE(div(pp.price * tok."totalSupply", 1000000000000000000000000000::numeric), 0)::text
                                                         AS "priorMarketCap"
    FROM recent r
    JOIN tokens tok ON tok.id = r."tokenId"
    LEFT JOIN prior p ON p."tokenId" = r."tokenId"
    LEFT JOIN prior_price pp ON pp."tokenId" = r."tokenId"
    WHERE tok."moderationStatus" NOT IN ('HIDDEN', 'FLAGGED')`;

  console.log(`cohort        : ${rows.length} tokens traded in the recent window\n`);
  if (rows.length === 0) {
    console.log("Nothing traded in that window. Widen it with --window, or wait for");
    console.log("the indexer to catch up.");
    await prisma.$disconnect();
    return;
  }

  const int = (value: string): bigint => BigInt(value.split(".")[0] ?? "0");
  const inputs: TrendingInput[] = rows.map((row) => ({
    tokenId: row.tokenId,
    recentVolume: int(row.recentVolume),
    priorVolume: int(row.priorVolume),
    // eslint-disable-next-line no-restricted-syntax -- a trader count is not money
    uniqueTraders: Number(row.uniqueTraders),
    // eslint-disable-next-line no-restricted-syntax -- a trade count is not money
    tradeCount: Number(row.tradeCount),
    buyVolume: int(row.buyVolume),
    sellVolume: int(row.sellVolume),
    marketCap: int(row.marketCap),
    priorMarketCap: int(row.priorMarketCap),
  }));

  const scored = scoreTrending(inputs, DEFAULT_TRENDING_WEIGHTS).sort((a, b) =>
    a.scoreBps > b.scoreBps ? -1 : a.scoreBps < b.scoreBps ? 1 : 0,
  );

  const top = scored.slice(0, 10);
  const names = await prisma.token.findMany({
    where: { id: { in: top.map((entry) => entry.tokenId) } },
    select: { id: true, symbol: true },
  });
  const symbolOf = new Map(names.map((token) => [token.id, token.symbol]));
  console.log("top 10 by score:");
  for (const [rank, entry] of top.entries()) {
    const pct = (Number(entry.scoreBps) / 100).toFixed(1);
    console.log(
      `  ${String(rank + 1).padStart(2)}. ${(symbolOf.get(entry.tokenId) ?? "?").padEnd(14)} ${pct.padStart(6)}%`,
    );
  }

  if (dryRun) {
    console.log("\nDry run. No score was written.");
    await prisma.$disconnect();
    return;
  }

  // Everything outside the cohort goes back to zero, so a token that stopped trading
  // stops being ranked instead of keeping yesterday's score forever.
  const cleared = await prisma.token.updateMany({
    where: {
      chainId,
      trendingScore: { gt: 0 },
      id: { notIn: scored.map((s) => s.tokenId) },
    },
    data: { trendingScore: 0 },
  });

  let written = 0;
  for (let offset = 0; offset < scored.length; offset += WRITE_CHUNK) {
    const chunk = scored.slice(offset, offset + WRITE_CHUNK);
    await Promise.all(
      chunk.map((entry) =>
        prisma.token.update({
          where: { id: entry.tokenId },
          // scoreBps is 0..10000; the column is Decimal(20,8) so it lands exactly.
          data: { trendingScore: entry.scoreBps.toString() },
        }),
      ),
    );
    written += chunk.length;
  }

  console.log(`\n  ${written} scores written, ${cleared.count} cleared`);
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
