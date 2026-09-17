/**
 * Keep the database inside its size limit by dropping old trade history.
 *
 *   pnpm prune:trades                          report what would go, delete nothing
 *   pnpm prune:trades -- --apply               perform it
 *   pnpm prune:trades -- --days 14 --apply     keep two weeks instead of one
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

  const cutoff = new Date(Date.now() - days * 86_400_000);
  console.log(`mode          : ${apply ? "APPLY" : "DRY RUN — nothing is deleted"}`);
  console.log(`keeping       : trades newer than ${cutoff.toISOString()} (${days} days)`);
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

    // Say WHY nothing matched, because on this chain the usual reason is that the
    // retention window is longer than the database can physically hold.
    const spanRows = await prisma.$queryRaw<{ hours: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 3600 AS hours
      FROM trades WHERE "chainId" = ${chainId}`;
    const hours = spanRows[0]?.hours ?? null;
    if (hours !== null && hours > 0 && hours < days * 24) {
      const perHour = total / hours;
      console.log(
        `  The stored trades span ${hours.toFixed(1)} hours — less than the ${days}-day\n` +
          `  window — so nothing is old enough to remove. At ${Math.round(perHour)} trades an hour\n` +
          `  this chain produces roughly 27 MB of trade data per hour, which is why the\n` +
          `  database fills long before any of it reaches ${days} days old.\n\n` +
          `  A retention window only frees space if it is SHORTER than what fits. Try\n` +
          `  --days 1, or move to a database that can hold the history you want.`,
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
