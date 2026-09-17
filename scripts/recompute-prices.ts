/**
 * Restate stored prices at the current PRICE_SCALE.
 *
 * WHY THIS IS NEEDED
 *
 * `price` is a fixed-point integer, and its scale is not stored beside it. Rows
 * written under the old 1e18 scale and rows written under the current 1e27 scale sit
 * in the same column and are not comparable: sorting by market cap, the trending
 * engine and every displayed price would mix the two silently.
 *
 * The scale moved because 1e18 was chosen for an 18-decimal quote asset and this
 * chain has approved quote assets with 6 and 8 decimals. Measured on 2026-09-17: all
 * 124 tokens quoted in the 8-decimal asset had price 0, including one with 395
 * settled trades. See R40 in docs/KNOWN_RISKS.md.
 *
 * WHAT IT DOES
 *
 *   trades.price  recomputed from quoteAmount and tokenAmount, which are untouched
 *   tokens.price  restated from the token's most recent trade, or left alone
 *   tokens.marketCap  recomputed from the restated price
 *
 * `marketCap` is invariant under the scale change in exact arithmetic, but it is
 * recomputed anyway: a cap derived from a price that had already floored to zero is
 * itself zero, and no amount of rescaling recovers it.
 *
 * Trade amounts are never modified. They are what the chain emitted; price is derived.
 *
 * HOW TO RUN IT
 *
 *   pnpm recompute:prices -- --dry-run     report what would change, write nothing
 *   pnpm recompute:prices -- --apply       perform it
 *
 * Stop the indexer first. It writes the same rows, and a concurrent recompute would
 * interleave with it.
 *
 * SAFE TO INTERRUPT AND RE-RUN. Every row is recomputed from `quoteAmount` and
 * `tokenAmount`, and a row already holding the correct value is skipped, so a second
 * run finishes whatever the first did not and a completed run is a no-op. If the
 * connection drops halfway through, start it again.
 *
 * This is a long, write-heavy pass over every trade. Run it deliberately.
 */

import { Prisma } from "@prisma/client";
import { getPrisma } from "@stunks/database";
import { ROBINHOOD_CHAIN_ID } from "@stunks/config";
import { PRICE_SCALE, priceFromTrade } from "../apps/indexer/src/pricing.js";

/**
 * The price scale, written out in full.
 *
 * NOT `1e27`: that is a float8 literal in Postgres, and a float has no place anywhere
 * near a money column in this project. Spelled out and cast, it stays `numeric`, which
 * Postgres computes exactly at arbitrary precision.
 */
const SCALE_SQL = Prisma.sql`1000000000000000000000000000::numeric`;

/**
 * `priceFromTrade`, expressed in SQL.
 *
 * Mirrors the TypeScript exactly: zero when either leg is zero, otherwise
 * floor(quote * SCALE / token).
 *
 * `div(a, b)` and NOT `trunc(a / b)`. Postgres evaluates `numeric / numeric` to a
 * limited number of digits and ROUNDS there, so a true quotient of 1234.9999… becomes
 * 1235.000 and `trunc` then returns 1235 instead of 1234. Checked against
 * `priceFromTrade` over 5,000 real rows, the rounding version disagreed on 1,132 of
 * them. `div` is integer division and truncates, which is what Solidity does and what
 * `mulDiv` in @stunks/utils reproduces.
 *
 * A second implementation is a second thing to get wrong, so the run verifies its
 * output against the real function afterwards rather than assuming these agree.
 */
const PRICE_SQL = Prisma.sql`
  CASE WHEN "tokenAmount" > 0 AND "quoteAmount" > 0
       THEN div("quoteAmount" * ${SCALE_SQL}, "tokenAmount")
       ELSE 0 END`;

/** Rows re-checked in TypeScript after the SQL has run. */
const VERIFY_SAMPLE = 5_000;

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

/**
 * Compare what the SQL produces against `priceFromTrade` over a sample of real rows.
 *
 * Postgres is asked to evaluate the expression without writing it, so this is safe to
 * run before a migration as well as after. Returns false on any disagreement.
 */
async function verifyAgainstTypeScript(
  prisma: ReturnType<typeof getPrisma>,
  chainId: number,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<
    { sql_price: string; quote: string; token: string }[]
  >`
    SELECT ${PRICE_SQL}::text AS sql_price,
           "quoteAmount"::text AS quote,
           "tokenAmount"::text AS token
    FROM trades WHERE "chainId" = ${chainId}
    ORDER BY id ASC LIMIT ${VERIFY_SAMPLE}`;

  let mismatches = 0;
  for (const row of rows) {
    const expected = priceFromTrade({
      quoteAmount: BigInt(row.quote.split(".")[0] ?? "0"),
      tokenAmount: BigInt(row.token.split(".")[0] ?? "0"),
    });
    if (BigInt(row.sql_price.split(".")[0] ?? "0") !== expected) mismatches += 1;
  }
  console.log(
    `  formula check: ${rows.length} rows, ${mismatches} disagreement(s) with priceFromTrade`,
  );
  return mismatches === 0;
}

async function main(): Promise<void> {
  const apply = has("apply");
  const dryRun = has("dry-run") || !apply;

  if (!apply && !has("dry-run")) {
    console.log("No mode given; defaulting to --dry-run. Pass --apply to write.\n");
  }
  console.log(`mode: ${dryRun ? "DRY RUN — nothing is written" : "APPLY"}`);
  console.log(`target scale: 1e${PRICE_SCALE.toString().length - 1}\n`);

  const prisma = getPrisma();
  const chainId = ROBINHOOD_CHAIN_ID;

  const total = await prisma.trade.count({ where: { chainId } });
  console.log(`trades in scope: ${total}\n`);

  // How many rows disagree with the formula, before touching anything.
  const wrongRows = await prisma.$queryRaw<{ wrong: bigint }[]>`
    SELECT COUNT(*) AS wrong FROM trades
    WHERE "chainId" = ${chainId} AND price <> ${PRICE_SQL}`;
  const destroyedRows = await prisma.$queryRaw<{ destroyed: bigint }[]>`
    SELECT COUNT(*) AS destroyed FROM trades
    WHERE "chainId" = ${chainId} AND price = 0
      AND "quoteAmount" > 0 AND "tokenAmount" > 0`;
  const wrong = wrongRows[0]?.wrong ?? 0n;
  const destroyed = destroyedRows[0]?.destroyed ?? 0n;

  console.log(`  trades needing a new price : ${wrong}`);
  console.log(`  of which stored zero       : ${destroyed}\n`);

  // Check the two implementations agree BEFORE anything is written.
  //
  // The SQL below is a second implementation of `priceFromTrade`, and a second
  // implementation is a second thing to get wrong. Asking Postgres what it WOULD
  // produce and comparing that against the real function costs one read and answers
  // the only question that matters before a migration: is the formula right.
  const agreed = await verifyAgainstTypeScript(prisma, chainId);
  if (!agreed) {
    console.error(
      "\n  SQL and priceFromTrade disagree. Nothing has been written.\n" +
        "  Fix the formula before running with --apply.",
    );
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  if (dryRun) {
    console.log("  Dry run. Nothing was written. Re-run with --apply to perform it.");
    await prisma.$disconnect();
    return;
  }

  // ONE statement, executed by Postgres over its own rows.
  //
  // The previous version sent 441,390 updates across the network from Node. Measured
  // on the real database: batches with nothing to change took a second; the first
  // batch that actually wrote 2,000 rows took 99, which puts the whole pass at about
  // six hours. The arithmetic is a multiply and a floor-divide — there is no reason
  // for any of it to leave the database.
  //
  // `numeric` is exact and arbitrary-precision in Postgres, and `trunc` on a positive
  // value is floor, so this matches `mulDiv` in @stunks/utils exactly. The scale is
  // written out in full rather than as 1e27, which would be a float literal and would
  // put a float in the middle of a money path.
  console.log("  rewriting trade prices in one statement...");
  const startedTrades = Date.now();
  const tradesWritten = await prisma.$executeRaw`
    UPDATE trades SET price = ${PRICE_SQL}
    WHERE "chainId" = ${chainId} AND price <> ${PRICE_SQL}`;
  console.log(
    `  ${tradesWritten} trade rows in ${((Date.now() - startedTrades) / 1000).toFixed(1)}s\n`,
  );

  // Token price is the price of its most recent trade, matching the indexer's
  // `latestForTokens`, and market cap follows from it.
  console.log("  restating token prices from their latest trade...");
  const startedTokens = Date.now();
  const tokensWritten = await prisma.$executeRaw`
    UPDATE tokens AS t
    SET price = latest.price,
        "marketCap" = div(latest.price * t."totalSupply", ${SCALE_SQL}),
        "updatedAt" = now()
    FROM (
      SELECT DISTINCT ON ("tokenId") "tokenId", price
      FROM trades WHERE "chainId" = ${chainId}
      ORDER BY "tokenId", "blockNumber" DESC, "logIndex" DESC
    ) AS latest
    WHERE t.id = latest."tokenId"
      AND (t.price <> latest.price
           OR t."marketCap" <> div(latest.price * t."totalSupply", ${SCALE_SQL}))`;
  console.log(
    `  ${tokensWritten} token rows in ${((Date.now() - startedTokens) / 1000).toFixed(1)}s\n`,
  );

  // And again on the rows as they now stand, so the report is about what was written
  // rather than about what was planned.
  const stillAgrees = await verifyAgainstTypeScript(prisma, chainId);
  if (!stillAgrees) {
    console.error(
      "  The written rows do not match priceFromTrade. Investigate before trusting\n" +
        "  them, and do not start the indexer yet.",
    );
    process.exitCode = 1;
  } else {
    console.log("  Done. Start the indexer.");
  }

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
