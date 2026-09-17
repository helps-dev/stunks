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

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
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

  const total = await prisma.trade.count({ where: { chainId: ROBINHOOD_CHAIN_ID } });
  console.log(`trades to examine: ${total}\n`);

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

      if (apply) {
        await prisma.trade.update({
          where: { id: row.id },
          data: { price: toDecimal(correct) },
        });
      }
    }

    process.stdout.write(`\r  examined ${seen}/${total}  to change: ${changed}`);
  }
  console.log("\n");
  console.log(`  trades needing a new price : ${changed}`);
  console.log(`  of which stored zero       : ${zeroBefore}`);
  console.log(`  zero -> a real price       : ${rescuedFromZero}\n`);

  // Tokens take their price from their most recent trade, matching the indexer.
  const tokens = await prisma.token.findMany({
    where: { chainId: ROBINHOOD_CHAIN_ID },
    select: { id: true, symbol: true, price: true, totalSupply: true },
  });
  let tokensChanged = 0;
  for (const token of tokens) {
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
      await prisma.token.update({
        where: { id: token.id },
        data: {
          price: toDecimal(price),
          marketCap: toDecimal(marketCapFromPrice(price, toBigInt(token.totalSupply))),
        },
      });
    }
  }
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
