/**
 * Keep the database inside its size limit by dropping old trade history.
 *
 *   pnpm prune:trades                          report what would go, delete nothing
 *   pnpm prune:trades -- --apply               perform it
 *   pnpm prune:trades -- --hours 6 --apply     keep six hours of raw trades
 *
 * RUN `rollup:aggregates` FIRST. Nothing is deleted beyond the point the rollup has
 * reached, whatever the retention window says, because a trade no candle covers is the
 * only copy of that history and rebuilding it means re-reading the chain.
 *
 * WHY TRADES AND NOT TOKENS
 *
 * Measured 2026-09-17: 23,680 tokens occupy 27 MB; 434,523 trades occupy 426 MB. Rows
 * in `tokens` are cheap and they are what every page, link and aggregate depends on,
 * so they are all kept. `trades` is 94% of the space and is the only thing removed.
 *
 * Capping the token count instead would have been far worse than it sounds. This chain
 * launches 545 tokens an hour, so a 1,000-token cap is 110 MINUTES of history — every
 * shared link dead within two hours — and because `Trade.token` cascades, it deletes
 * the trades anyway, just indirectly.
 *
 * WHAT IS LOST, AND WHAT IS NOT
 *
 * A token whose trades are pruned keeps its page, its name, its curve, its phase, its
 * price, its market cap and its counters — those live on the token row. What goes is
 * the itemised trade list below them.
 *
 * TRENDING TOKENS ARE EXEMPT
 *
 * A token near the top of the trending ranking is precisely the one whose history
 * someone is about to look at, and its own score is computed FROM that history. So the
 * top `--keep-trending` tokens by score keep all of theirs. Run `pnpm score:trending`
 * first: the exemption is only as current as the scores it reads.
 *
 * THIS IS INCOMPATIBLE WITH BACKFILLING
 *
 * Retention is measured against the wall clock, so trades recovered from older history
 * arrive already expired and would be deleted on the next run. Covering the ~38M
 * unindexed blocks (R39) and running this are mutually exclusive on one database.
 */

import { getPrisma } from "@stunks/database";
import { ROBINHOOD_CHAIN_ID } from "@stunks/config";

/** Rows deleted per statement, then vacuumed. Sized for a nearly full project. */
const CHUNK = 20_000;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  // eslint-disable-next-line no-restricted-syntax -- a day or row count is not money
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`--${name} needs a positive whole number`);
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const apply = flag("apply");
  const days = numberArg("days", 7);
  const keepTrending = numberArg("keep-trending", 500);
  const prisma = getPrisma();
  const chainId = ROBINHOOD_CHAIN_ID;

  const hours = numberArg("hours", days * 24);
  console.log(`mode          : ${apply ? "DELETE" : "DRY RUN — nothing is deleted"}`);

  // The rollup boundary is the hard ceiling on what may be deleted.
  //
  // A trade that no candle covers is the only copy of that history: nothing can rebuild
  // it except re-reading the chain, which for this range is days of RPC. So the cutoff
  // is whichever is EARLIER — the retention window, or the point the rollup has
  // actually reached.
  const rolledRows = await prisma.$queryRaw<{ built: Date | null }[]>`
    SELECT MAX("openTime") AS built FROM candles WHERE interval = 3600`;
  const built = rolledRows[0]?.built ?? null;
  if (built === null) {
    console.log(
      "\n  No hourly candles exist, so no trade is covered by an aggregate and\n" +
        "  nothing can safely be deleted. Run `pnpm rollup:aggregates -- --apply` first.",
    );
    await prisma.$disconnect();
    return;
  }
  // The candle at `built` covers [built, built + 1h), so everything before its end is
  // aggregated.
  const rolledThrough = new Date(built.getTime() + 3_600_000);

  const byRetention = new Date(Date.now() - hours * 3_600_000);
  const cutoff = byRetention < rolledThrough ? byRetention : rolledThrough;

  console.log(`rolled up to  : ${rolledThrough.toISOString()}`);
  console.log(
    `retention     : ${hours}h, i.e. trades after ${byRetention.toISOString()}`,
  );
  console.log(`cutoff        : ${cutoff.toISOString()} (the earlier of the two)`);
  console.log(`exempt        : top ${keepTrending} tokens by trending score`);

  const sizeRows = await prisma.$queryRaw<{ size: string }[]>`
    SELECT pg_size_pretty(pg_database_size(current_database())) AS size`;
  console.log(`database size : ${sizeRows[0]?.size ?? "unknown"}\n`);

  // The exemption list. A score of zero means "not ranked", so those never qualify
  // however few tokens carry a score.
  const exempt = await prisma.token.findMany({
    where: { chainId, trendingScore: { gt: 0 } },
    select: { id: true },
    orderBy: { trendingScore: "desc" },
    take: keepTrending,
  });
  const exemptIds = exempt.map((token) => token.id);
  console.log(`  exempt tokens carrying a score : ${exemptIds.length}`);
  if (exemptIds.length === 0) {
    console.log("  (none are scored — run `pnpm score:trending` first if that is wrong)");
  }

  const doomed = await prisma.trade.count({
    where: {
      chainId,
      timestamp: { lt: cutoff },
      ...(exemptIds.length > 0 ? { tokenId: { notIn: exemptIds } } : {}),
    },
  });
  const total = await prisma.trade.count({ where: { chainId } });
  console.log(`  trades older than the cutoff   : ${doomed} of ${total}`);
  console.log(
    `  estimated space freed          : ~${Math.round((doomed * 1024) / 1_048_576)} MB\n`,
  );

  if (doomed === 0) {
    console.log("  Nothing to do.\n");

    // Say WHICH constraint bound, because the two have opposite remedies and the
    // wrong diagnosis sends you to change a setting that was never the problem.
    const spanRows = await prisma.$queryRaw<{ hours: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 3600 AS hours
      FROM trades WHERE "chainId" = ${chainId}`;
    const span = spanRows[0]?.hours ?? null;

    if (cutoff.getTime() === rolledThrough.getTime()) {
      // The rollup boundary won, so retention never came into it. This is the normal
      // state while the indexer is running: it writes trades faster than the rollup
      // turns them into aggregates, and the interlock refuses to delete the difference.
      console.log(
        `  The cutoff came from the ROLLUP boundary, not the ${hours}-hour window —\n` +
          `  everything still here was indexed after ${rolledThrough.toISOString()}\n` +
          `  and no aggregate covers it yet. Nothing is wrong: the interlock is doing\n` +
          `  exactly its job.\n\n` +
          `  Run \`pnpm rollup:aggregates -- --apply\` once another hour completes, then\n` +
          `  this again. Changing --hours would have no effect while the rollup is what\n` +
          `  binds.`,
      );
    } else if (span !== null && span > 0 && span < hours) {
      const suggestion = Math.max(1, Math.floor(span / 2));
      console.log(
        `  The stored trades span ${span.toFixed(1)} hours — shorter than the ${hours}-hour\n` +
          `  window — so nothing is old enough to remove. This chain produces roughly\n` +
          `  27 MB of trade rows an hour (R42), which is why a window measured in days\n` +
          `  never matches anything here.\n\n` +
          `  A window only frees space if it is SHORTER than what is stored. Try\n` +
          `  --hours ${suggestion}.`,
      );
    }
    await prisma.$disconnect();
    return;
  }

  if (!apply) {
    console.log("  Dry run. Nothing was deleted. Re-run with --apply to perform it.");
    await prisma.$disconnect();
    return;
  }

  // Chunked, with a VACUUM between, for the same reason the price recompute is: on a
  // size-capped project a single statement over hundreds of thousands of rows runs out
  // of room before it commits.
  const started = Date.now();
  let removed = 0;
  for (;;) {
    const batch = await prisma.trade.findMany({
      where: {
        chainId,
        timestamp: { lt: cutoff },
        ...(exemptIds.length > 0 ? { tokenId: { notIn: exemptIds } } : {}),
      },
      select: { id: true },
      take: CHUNK,
    });
    if (batch.length === 0) break;

    const result = await prisma.trade.deleteMany({
      where: { id: { in: batch.map((trade) => trade.id) } },
    });
    removed += result.count;
    try {
      await prisma.$executeRawUnsafe("VACUUM trades");
    } catch (error) {
      console.error(
        `\n  VACUUM failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
    console.log(
      `    ${removed}/${doomed} (${((Date.now() - started) / 1000).toFixed(0)}s)`,
    );
  }

  const after = await prisma.$queryRaw<{ size: string }[]>`
    SELECT pg_size_pretty(pg_database_size(current_database())) AS size`;
  console.log(
    `\n  ${removed} trades deleted in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  console.log(`  database size now: ${after[0]?.size ?? "unknown"}`);
  console.log(
    "\n  VACUUM makes the space reusable but does not hand it back to the provider.\n" +
      "  The reported size may not drop until the freed pages are written into again.",
  );

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
