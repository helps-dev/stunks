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

import { getPrisma, toDecimal, toBigInt } from "@stunks/database";
import { ROBINHOOD_CHAIN_ID } from "@stunks/config";
import {
  PRICE_SCALE,
  marketCapFromPrice,
  priceFromTrade,
} from "../apps/indexer/src/pricing.js";

const BATCH = 2_000;
/**
 * In-flight updates. High enough to hide the round trip, low enough to stay well
 * inside a pooled connection allowance and leave room for the indexer.
 */
const WRITE_CONCURRENCY = 24;

/** Run `task` over `items`, never more than `limit` at once. Preserves no order. */
async function runConcurrently<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await task(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}
/** How often to print a progress line. Every batch would be noisy; never is worse. */
const PROGRESS_EVERY = 20_000;

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

/**
 * `--limit N` stops after N trades and skips the token pass.
 *
 * A trial run, and it exists because the write path here was twice changed and twice
 * shipped without ever having executed — the second attempt hung against a pooled
 * connection and wrote nothing at all, which a dry run cannot reveal because a dry run
 * writes nothing by definition. A hundred rows proves the writes land in seconds, and
 * the script is idempotent, so the trial is simply part of the real run.
 */
function limit(): number | null {
  const index = process.argv.indexOf("--limit");
  if (index === -1) return null;
  const raw = process.argv[index + 1];
  // eslint-disable-next-line no-restricted-syntax -- a row count is not money
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`--limit needs a positive whole number, got: ${raw ?? "(nothing)"}`);
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const apply = has("apply");
  const dryRun = has("dry-run") || !apply;
  const maxRows = limit();

  if (!apply && !has("dry-run")) {
    console.log("No mode given; defaulting to --dry-run. Pass --apply to write.\n");
  }
  console.log(`mode: ${dryRun ? "DRY RUN — nothing is written" : "APPLY"}`);
  if (maxRows !== null) {
    console.log(`limit: ${maxRows} trades, and the token pass is skipped`);
  }
  console.log(`target scale: 1e${PRICE_SCALE.toString().length - 1}\n`);

  const prisma = getPrisma();

  const total = await prisma.trade.count({ where: { chainId: ROBINHOOD_CHAIN_ID } });
  console.log(`trades to examine: ${total}\n`);

  const startedAt = Date.now();
  /** Accumulated per batch, flushed as one transaction. */
  const pendingWrites: { id: string; price: bigint }[] = [];
  let seen = 0;
  let changed = 0;
  let zeroBefore = 0;
  let rescuedFromZero = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.trade.findMany({
      where: { chainId: ROBINHOOD_CHAIN_ID },
      select: { id: true, price: true, quoteAmount: true, tokenAmount: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    if (maxRows !== null && seen >= maxRows) break;

    for (const row of rows) {
      seen += 1;
      const stored = toBigInt(row.price);
      const correct = priceFromTrade({
        quoteAmount: toBigInt(row.quoteAmount),
        tokenAmount: toBigInt(row.tokenAmount),
      });
      if (stored === correct) continue;
      changed += 1;
      if (stored === 0n) zeroBefore += 1;
      if (stored === 0n && correct > 0n) rescuedFromZero += 1;

      if (apply) pendingWrites.push({ id: row.id, price: correct });
    }

    // Writes go out CONCURRENTLY, not batched into one transaction.
    //
    // Two wrong turns are recorded here because the second looked like the fix for the
    // first. A row-at-a-time loop was too slow: reads already came back 2,000 at a
    // time, so the read pass finished in about a minute while the write pass would
    // have made 441,390 separate round trips. Wrapping each batch in `$transaction`
    // fixed the round trips and hung outright — DATABASE_URL is Neon's POOLED host,
    // and a 2,000-statement explicit transaction through a connection pooler is the
    // same class of problem the project already documents for DDL, which is why
    // DIRECT_URL exists. Observed: process alive, log frozen, zero rows written.
    //
    // Concurrency without an explicit transaction avoids both. Each update is its own
    // implicit transaction, which a pooler handles fine, and the work is idempotent —
    // a row is recomputed from immutable trade amounts and skipped if already correct
    // — so batch atomicity buys nothing here.
    await runConcurrently(pendingWrites, WRITE_CONCURRENCY, (write) =>
      prisma.trade.update({
        where: { id: write.id },
        data: { price: toDecimal(write.price) },
      }),
    );
    pendingWrites.length = 0;

    // Newline-terminated, not a \r progress bar. This is a long unattended pass over
    // hundreds of thousands of rows, so it is run with nohup or under a service and
    // its output is redirected — where a carriage-return bar buffers into nothing and
    // the operator cannot tell a slow run from a hung one.
    // Every batch while writing, so a stall is visible within seconds rather than
    // after ten batches. That delay is what made the hang above look like slowness.
    if (apply || seen % PROGRESS_EVERY < BATCH) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `  examined ${seen}/${total}  to change: ${changed}  (${elapsed}s elapsed)`,
      );
    }
  }
  console.log("");
  console.log(`  trades needing a new price : ${changed}`);
  console.log(`  of which stored zero       : ${zeroBefore}`);
  console.log(`  zero -> a real price       : ${rescuedFromZero}\n`);

  if (maxRows !== null) {
    console.log(`\n  Trial run of ${maxRows} trades finished. Token pass skipped.`);
    console.log(
      "  Re-run without --limit to complete it; already-correct rows are skipped.",
    );
    await prisma.$disconnect();
    return;
  }

  // Tokens take their price from their most recent trade, matching the indexer.
  const tokens = await prisma.token.findMany({
    where: { chainId: ROBINHOOD_CHAIN_ID },
    select: { id: true, symbol: true, price: true, totalSupply: true },
  });
  console.log(`\n  restating ${tokens.length} token prices from their latest trade`);
  let tokensChanged = 0;
  let tokensSeen = 0;
  const tokenWrites: { id: string; price: bigint; marketCap: bigint }[] = [];
  const flushTokenWrites = async (): Promise<void> => {
    await runConcurrently(tokenWrites, WRITE_CONCURRENCY, (write) =>
      prisma.token.update({
        where: { id: write.id },
        data: {
          price: toDecimal(write.price),
          marketCap: toDecimal(write.marketCap),
        },
      }),
    );
    tokenWrites.length = 0;
  };
  for (const token of tokens) {
    tokensSeen += 1;
    if (tokensSeen % 5_000 === 0) {
      console.log(`  tokens ${tokensSeen}/${tokens.length}  to change: ${tokensChanged}`);
    }
    const latest = await prisma.trade.findFirst({
      where: { tokenId: token.id },
      orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
      select: { quoteAmount: true, tokenAmount: true },
    });
    // No trades: the opening price came from curve reserves and is re-derived by the
    // indexer when it next sees the launch. Left alone here rather than guessed at.
    if (!latest) continue;

    const price = priceFromTrade({
      quoteAmount: toBigInt(latest.quoteAmount),
      tokenAmount: toBigInt(latest.tokenAmount),
    });
    if (toBigInt(token.price) === price) continue;
    tokensChanged += 1;
    if (apply) {
      tokenWrites.push({
        id: token.id,
        price,
        marketCap: marketCapFromPrice(price, toBigInt(token.totalSupply)),
      });
      if (tokenWrites.length >= BATCH) {
        await flushTokenWrites();
      }
    }
  }
  if (apply && tokenWrites.length > 0) await flushTokenWrites();
  console.log(`  tokens needing a new price : ${tokensChanged} of ${tokens.length}`);

  if (dryRun) {
    console.log("\n  Dry run. Nothing was written. Re-run with --apply to perform it.");
  } else {
    console.log("\n  Done. Restart the indexer.");
  }
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
