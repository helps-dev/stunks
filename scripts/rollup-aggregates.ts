/**
 * Roll raw trades up into hourly candles and volume snapshots.
 *
 *   pnpm rollup:aggregates              report what would be built, write nothing
 *   pnpm rollup:aggregates -- --apply   build it
 *
 * WHY THIS EXISTS
 *
 * Measured 2026-09-17: this chain produces 28,244 trades an hour, and a trade row with
 * its indexes costs about 1 KB — roughly 27 MB per hour. A 512 MB database therefore
 * holds about 19 hours of history, and no retention window changes that arithmetic
 * (R42). Aggregates are the way out: an hour of one token's trading collapses to two
 * small rows, and the `candles` and `volume_snapshots` tables have been in the schema
 * for this since it was written, unwritten by anything.
 *
 * WHAT EACH TABLE IS FOR
 *
 *   candles           open/high/low/close plus volume — price history, and the reason
 *                     a chart is possible at all
 *   volume_snapshots  volume, the buy/sell split and DISTINCT traders — the inputs
 *                     `scoreTrending` needs, which a candle cannot supply
 *
 * ONLY COMPLETE HOURS ARE BUILT. The hour containing the newest trade is still filling,
 * and rolling it up would freeze a partial bar that later trades would contradict.
 *
 * SAFE TO RE-RUN. Both tables have unique keys — (tokenId, interval, openTime) and
 * (tokenId, windowStart, venue) — and this upserts, so a repeat run recomputes the same
 * values rather than duplicating them. An interrupted run is finished by starting it
 * again.
 *
 * PRUNING DEPENDS ON THIS. `prune:trades` refuses to delete a trade that has not been
 * rolled up, so this has to run first. Deleting raw trades that no aggregate covers
 * would lose the history permanently — it cannot be rebuilt without re-reading the
 * chain.
 */

import { getPrisma } from "@stunks/database";
import { ROBINHOOD_CHAIN_ID } from "@stunks/config";

/** Seconds per candle. Hourly is the coarsest useful bar for a chain this fast. */
const INTERVAL_SECONDS = 3_600;

/** Hours built per statement, so a size-capped database is not asked for too much. */
const HOURS_PER_BATCH = 6;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const apply = flag("apply");
  const prisma = getPrisma();
  const chainId = ROBINHOOD_CHAIN_ID;

  console.log(`mode     : ${apply ? "APPLY" : "DRY RUN — nothing is written"}`);

  const boundsRows = await prisma.$queryRaw<
    { earliest: Date | null; latest: Date | null }[]
  >`SELECT MIN(timestamp) AS earliest, MAX(timestamp) AS latest
    FROM trades WHERE "chainId" = ${chainId}`;
  const earliest = boundsRows[0]?.earliest;
  const latest = boundsRows[0]?.latest;
  if (!earliest || !latest) {
    console.log("No trades to roll up.");
    await prisma.$disconnect();
    return;
  }

  // Everything strictly before the hour the newest trade falls in.
  const completeThrough = new Date(Math.floor(latest.getTime() / 3_600_000) * 3_600_000);

  const builtRows = await prisma.$queryRaw<{ built: Date | null }[]>`
    SELECT MAX("openTime") AS built FROM candles WHERE interval = ${INTERVAL_SECONDS}`;
  const alreadyBuilt = builtRows[0]?.built ?? null;
  const from = alreadyBuilt
    ? new Date(alreadyBuilt.getTime() + INTERVAL_SECONDS * 1000)
    : new Date(Math.floor(earliest.getTime() / 3_600_000) * 3_600_000);

  console.log(`trades   : ${earliest.toISOString()} .. ${latest.toISOString()}`);
  console.log(`built to : ${alreadyBuilt ? alreadyBuilt.toISOString() : "nothing yet"}`);
  console.log(`building : ${from.toISOString()} .. ${completeThrough.toISOString()}\n`);

  if (from >= completeThrough) {
    console.log("  Already up to date; the newest hour is still filling.");
    await prisma.$disconnect();
    return;
  }

  const hours = Math.round((completeThrough.getTime() - from.getTime()) / 3_600_000);
  console.log(`  ${hours} complete hour(s) to build`);

  if (!apply) {
    const preview = await prisma.$queryRaw<{ tokens: bigint; trades: bigint }[]>`
      SELECT COUNT(DISTINCT "tokenId") AS tokens, COUNT(*) AS trades
      FROM trades
      WHERE "chainId" = ${chainId} AND timestamp >= ${from} AND timestamp < ${completeThrough}`;
    const p = preview[0];
    console.log(`  covering ${p?.trades ?? 0} trades across ${p?.tokens ?? 0} tokens`);
    console.log("\n  Dry run. Nothing was written. Re-run with --apply to build it.");
    await prisma.$disconnect();
    return;
  }

  const started = Date.now();
  let candlesWritten = 0;
  let snapshotsWritten = 0;

  for (
    let cursor = from;
    cursor < completeThrough;
    cursor = new Date(cursor.getTime() + HOURS_PER_BATCH * 3_600_000)
  ) {
    const batchEnd = new Date(
      Math.min(cursor.getTime() + HOURS_PER_BATCH * 3_600_000, completeThrough.getTime()),
    );

    // `gen_random_uuid()::text` rather than a cuid: Prisma's @default(cuid()) is a
    // client-side generator and cannot run inside an INSERT ... SELECT. The column is
    // a plain string primary key, so the shape of the value does not matter.
    candlesWritten += await prisma.$executeRaw`
      INSERT INTO candles (
        id, "tokenId", interval, "openTime", open, high, low, close, volume, "tradeCount"
      )
      SELECT gen_random_uuid()::text,
             "tokenId",
             ${INTERVAL_SECONDS},
             date_trunc('hour', timestamp),
             (array_agg(price ORDER BY "blockNumber", "logIndex"))[1],
             MAX(price),
             MIN(price),
             (array_agg(price ORDER BY "blockNumber" DESC, "logIndex" DESC))[1],
             SUM("quoteAmount"),
             COUNT(*)
      FROM trades
      WHERE "chainId" = ${chainId} AND timestamp >= ${cursor} AND timestamp < ${batchEnd}
      GROUP BY "tokenId", date_trunc('hour', timestamp)
      ON CONFLICT ("tokenId", interval, "openTime") DO UPDATE SET
        open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
        close = EXCLUDED.close, volume = EXCLUDED.volume,
        "tradeCount" = EXCLUDED."tradeCount"`;

    snapshotsWritten += await prisma.$executeRaw`
      INSERT INTO volume_snapshots (
        id, "tokenId", "windowStart", "windowEnd", venue,
        volume, "buyVolume", "sellVolume", "tradeCount", "uniqueTraders",
        "openPrice", "closePrice"
      )
      SELECT gen_random_uuid()::text,
             "tokenId",
             date_trunc('hour', timestamp),
             date_trunc('hour', timestamp) + interval '1 hour',
             venue,
             SUM("quoteAmount"),
             COALESCE(SUM("quoteAmount") FILTER (WHERE side = 'BUY'), 0),
             COALESCE(SUM("quoteAmount") FILTER (WHERE side = 'SELL'), 0),
             COUNT(*),
             COUNT(DISTINCT "traderAddress"),
             (array_agg(price ORDER BY "blockNumber", "logIndex"))[1],
             (array_agg(price ORDER BY "blockNumber" DESC, "logIndex" DESC))[1]
      FROM trades
      WHERE "chainId" = ${chainId} AND timestamp >= ${cursor} AND timestamp < ${batchEnd}
      GROUP BY "tokenId", date_trunc('hour', timestamp), venue
      ON CONFLICT ("tokenId", "windowStart", venue) DO UPDATE SET
        "windowEnd" = EXCLUDED."windowEnd", volume = EXCLUDED.volume,
        "buyVolume" = EXCLUDED."buyVolume", "sellVolume" = EXCLUDED."sellVolume",
        "tradeCount" = EXCLUDED."tradeCount",
        "uniqueTraders" = EXCLUDED."uniqueTraders",
        "openPrice" = EXCLUDED."openPrice", "closePrice" = EXCLUDED."closePrice"`;

    console.log(
      `    through ${batchEnd.toISOString()}  candles ${candlesWritten}  snapshots ${snapshotsWritten}`,
    );
  }

  const sizes = await prisma.$queryRaw<{ candles: string; snapshots: string }[]>`
    SELECT pg_size_pretty(pg_total_relation_size('candles')) AS candles,
           pg_size_pretty(pg_total_relation_size('volume_snapshots')) AS snapshots`;

  console.log(
    `\n  ${candlesWritten} candles, ${snapshotsWritten} snapshots in ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  console.log(`  candles ${sizes[0]?.candles}, snapshots ${sizes[0]?.snapshots}`);
  console.log("\n  Raw trades up to this point are now safe to prune.");

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
