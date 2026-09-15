import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { toBigInt } from "../amount.js";
import { createRepositories, type Repositories } from "./index.js";

/**
 * Repository behaviour against a real Postgres instance.
 *
 * The properties under test are the ones that decide whether an indexer can be
 * trusted after a crash: replaying a log must not double-count, a checkpoint must
 * not silently move backwards, and a reorg must be recoverable. None of those can
 * be proven with a mock, because the guarantees live in the database constraints.
 *
 * Skipped unless RUN_DB_TESTS=1 so `pnpm test` stays hermetic.
 */

const enabled = process.env.RUN_DB_TESTS === "1";
const describeDb = enabled ? describe : describe.skip;

// Never use 4663 here. Reorg recovery intentionally deletes every indexed trade above
// a block, which is correct for the indexer but catastrophic if an integration fixture
// shares the real Robinhood Chain namespace. This ID exists only inside test rows.
const CHAIN_ID = 9_999_999;
const MARKER = "repo-integration-test";
const STREAM = `${MARKER}-stream`;

const prisma = new PrismaClient();
const repos: Repositories = createRepositories(prisma);

/** Values from the Phase 0 audit, so magnitudes are realistic. */
const SUPPLY = 1_000_000_000_000_000_000_000_000_000n;
const RESERVED = 285_714_285_714_285_714_285_714_285n;
const THRESHOLD = 4_200_000_000_000_000_000n;
const PHANTOM = 1_680_000_000_000_000_000n;
const TOKENS_OUT = 366_037_735_849_056_603_773_584_905n;

function launchInput(suffix: string) {
  return {
    chainId: CHAIN_ID,
    address: `0x${suffix.padStart(40, "0")}`,
    name: `Probe ${suffix}`,
    symbol: "PROBE",
    creatorAddress: `0x${"c".repeat(40)}`,
    deployerAddress: `0x${"d".repeat(40)}`,
    curveAddress: `0x${`${suffix}e`.padStart(40, "0")}`,
    pairTokenAddress: `0x${"0".repeat(40)}`,
    pairTokenDecimals: 18,
    launchConfigId: 0n,
    totalSupply: SUPPLY,
    creatorTaxBps: 200,
    buybackEnabled: true,
    graduationThreshold: THRESHOLD,
    poolFee: 0,
    tickSpacing: 200,
    phantomQuote: PHANTOM,
    reservedTokens: RESERVED,
    launchBlock: 26_841_846n,
    launchTxHash: MARKER,
  };
}

function tradeInput(tokenId: string, logIndex: number, blockNumber = 63_444_887n) {
  return {
    chainId: CHAIN_ID,
    transactionHash: MARKER,
    logIndex,
    blockNumber,
    blockHash: MARKER,
    tokenId,
    curveAddress: `0x${"e".repeat(40)}`,
    venue: "CURVE" as const,
    traderAddress: `0x${"A".repeat(40)}`,
    recipientAddress: `0x${"B".repeat(40)}`,
    side: "BUY" as const,
    tokenAmount: TOKENS_OUT,
    quoteAmount: 1_000_000_000_000_000_000n,
    feeAmount: 10_000_000_000_000_000n,
    creatorTaxAmount: 20_000_000_000_000_000n,
    snipeTaxAmount: 0n,
    refundAmount: 0n,
    price: 2_731_958_762n,
    marketCap: SUPPLY,
    timestamp: new Date(),
  };
}

async function cleanup(): Promise<void> {
  await prisma.trade.deleteMany({ where: { chainId: CHAIN_ID, blockHash: MARKER } });
  await prisma.token.deleteMany({ where: { chainId: CHAIN_ID, launchTxHash: MARKER } });
  await prisma.creator.deleteMany({
    where: { chainId: CHAIN_ID, address: `0x${"c".repeat(40)}` },
  });
  await prisma.indexerState.deleteMany({ where: { chainId: CHAIN_ID, stream: STREAM } });
  await prisma.failedBlock.deleteMany({ where: { chainId: CHAIN_ID, stream: STREAM } });
}

if (enabled) {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
}

describeDb("TokenRepository.recordLaunch", () => {
  it("creates the token and its creator together", async () => {
    const result = await repos.tokens.recordLaunch(launchInput("1"));
    expect(result.created).toBe(true);

    const token = await repos.tokens.findByAddress(CHAIN_ID, launchInput("1").address);
    expect(token).not.toBeNull();
    expect(toBigInt(token!.totalSupply)).toBe(SUPPLY);
    expect(toBigInt(token!.reservedTokens)).toBe(RESERVED);
    expect(token!.creatorId).toBeTruthy();
  });

  it("is idempotent: re-indexing the same launch does not duplicate it", async () => {
    const first = await repos.tokens.recordLaunch(launchInput("2"));
    const second = await repos.tokens.recordLaunch(launchInput("2"));
    const third = await repos.tokens.recordLaunch(launchInput("2"));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.tokenId).toBe(first.tokenId);

    const count = await prisma.token.count({
      where: { chainId: CHAIN_ID, launchTxHash: MARKER },
    });
    expect(count).toBe(1);
  });

  it("does not inflate the creator's token count on a replay", async () => {
    await repos.tokens.recordLaunch(launchInput("3"));
    await repos.tokens.recordLaunch(launchInput("3"));

    const creator = await prisma.creator.findUniqueOrThrow({
      where: { chainId_address: { chainId: CHAIN_ID, address: `0x${"c".repeat(40)}` } },
    });
    expect(creator.tokenCount).toBe(1);
  });

  it("normalises addresses to lowercase so lookups are consistent", async () => {
    const input = { ...launchInput("4"), address: `0x${"A".repeat(40)}` };
    await repos.tokens.recordLaunch(input);
    // Findable regardless of the casing used to query.
    const found = await repos.tokens.findByAddress(CHAIN_ID, `0x${"a".repeat(40)}`);
    expect(found).not.toBeNull();
  });

  it("finds a token by its curve address, the join key for trade logs", async () => {
    const input = launchInput("5");
    await repos.tokens.recordLaunch(input);
    const found = await repos.tokens.findByCurve(CHAIN_ID, input.curveAddress);
    expect(found?.address).toBe(input.address.toLowerCase());
  });

  it("records whitelist disclosure when a launch used a bundle", async () => {
    await repos.tokens.recordLaunch({ ...launchInput("6"), whitelistSize: 31 });
    const token = await repos.tokens.findByAddress(CHAIN_ID, launchInput("6").address);
    expect(token!.hadWhitelistBundle).toBe(true);
    expect(token!.whitelistSize).toBe(31);
  });
});

describeDb("TokenBatchRepository.updateStatsMany", () => {
  it("updates many tokens in one lossless set-based write", async () => {
    const first = await repos.tokens.recordLaunch(launchInput("60"));
    const second = await repos.tokens.recordLaunch(launchInput("61"));
    const lastTradeAt = new Date("2026-09-15T00:00:00.000Z");

    const updated = await repos.tokenBatch.updateStatsMany([
      {
        tokenId: first.tokenId,
        stats: {
          realQuoteReserve: 1_234_567_890_123_456_789n,
          graduationBps: 2_345,
          price: 9_876_543_210_987_654_321n,
          marketCap: SUPPLY,
          volume24h: 777_777_777_777_777_777n,
          volumeTotal: 888_888_888_888_888_888n,
          holderCount: 12,
          tradeCount: 34,
          buyCount: 21,
          sellCount: 13,
          lastTradeAt,
        },
      },
      {
        tokenId: second.tokenId,
        stats: {
          realQuoteReserve: 42n,
          graduationBps: 1,
          price: 99n,
          marketCap: 123n,
          volume24h: 456n,
          volumeTotal: 789n,
          holderCount: 2,
          tradeCount: 3,
          buyCount: 2,
          sellCount: 1,
        },
      },
    ]);

    expect(updated).toBe(2);
    const rows = await prisma.token.findMany({
      where: { id: { in: [first.tokenId, second.tokenId] } },
      orderBy: { id: "asc" },
    });
    const firstRow = rows.find((row) => row.id === first.tokenId)!;
    const secondRow = rows.find((row) => row.id === second.tokenId)!;

    expect(toBigInt(firstRow.realQuoteReserve)).toBe(1_234_567_890_123_456_789n);
    expect(toBigInt(firstRow.price)).toBe(9_876_543_210_987_654_321n);
    expect(firstRow.graduationBps).toBe(2_345);
    expect(firstRow.lastTradeAt).toEqual(lastTradeAt);
    expect(toBigInt(secondRow.realQuoteReserve)).toBe(42n);
    expect(secondRow.tradeCount).toBe(3);
    expect(secondRow.lastTradeAt).toBeNull();
  });
});

describeDb("TradeRepository idempotency", () => {
  it("records a trade once and reports the replay as not-created", async () => {
    const { tokenId } = await repos.tokens.recordLaunch(launchInput("7"));

    const first = await repos.trades.record(tradeInput(tokenId, 0));
    const second = await repos.trades.record(tradeInput(tokenId, 0));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const count = await prisma.trade.count({
      where: { chainId: CHAIN_ID, transactionHash: MARKER, logIndex: 0 },
    });
    expect(count).toBe(1);
  });

  it("preserves the exact token amount through the write", async () => {
    const { tokenId } = await repos.tokens.recordLaunch(launchInput("8"));
    await repos.trades.record(tradeInput(tokenId, 0));

    const trade = await prisma.trade.findUniqueOrThrow({
      where: {
        chainId_transactionHash_logIndex: {
          chainId: CHAIN_ID,
          transactionHash: MARKER,
          logIndex: 0,
        },
      },
    });
    // The verified 1 ETH quote vector, intact.
    expect(toBigInt(trade.tokenAmount)).toBe(TOKENS_OUT);
  });

  it("treats an overlapping batch window as cheap, not as an error", async () => {
    const { tokenId } = await repos.tokens.recordLaunch(launchInput("9"));

    const batch = [0, 1, 2, 3].map((i) => tradeInput(tokenId, i));
    const first = await repos.trades.recordMany(batch);
    expect(first.inserted).toBe(4);

    // The adaptive log window changed and the range re-overlapped.
    const overlapping = [2, 3, 4, 5].map((i) => tradeInput(tokenId, i));
    const second = await repos.trades.recordMany(overlapping);
    expect(second.inserted).toBe(2);

    const total = await prisma.trade.count({ where: { chainId: CHAIN_ID, tokenId } });
    expect(total).toBe(6);
  });

  it("handles an empty batch without a round trip", async () => {
    const result = await repos.trades.recordMany([]);
    expect(result.inserted).toBe(0);
  });

  it("distinguishes trader from recipient, which a bundle buy depends on", async () => {
    const { tokenId } = await repos.tokens.recordLaunch(launchInput("a"));
    await repos.trades.record(tradeInput(tokenId, 0));

    const trade = await prisma.trade.findFirstOrThrow({ where: { tokenId } });
    // One payer, a different recipient — the shape of a whitelist bundle buy.
    expect(trade.traderAddress).not.toBe(trade.recipientAddress);
    expect(trade.traderAddress).toBe(`0x${"a".repeat(40)}`);
  });
});

describeDb("reorg recovery", () => {
  it("deletes only trades above the reorg point", async () => {
    const { tokenId } = await repos.tokens.recordLaunch(launchInput("b"));

    await repos.trades.record(tradeInput(tokenId, 0, 100n));
    await repos.trades.record(tradeInput(tokenId, 1, 200n));
    await repos.trades.record(tradeInput(tokenId, 2, 300n));

    const deleted = await repos.trades.deleteAboveBlock(CHAIN_ID, 150n);
    expect(deleted).toBe(2);

    const remaining = await prisma.trade.findMany({ where: { tokenId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.blockNumber).toBe(100n);
  });
});

describeDb("CheckpointRepository", () => {
  it("creates a checkpoint at the contract deploy block, not at genesis", async () => {
    const state = await repos.checkpoints.getOrCreate(CHAIN_ID, STREAM, 26_841_846n);
    // Starting at zero would waste 26.8M blocks.
    expect(state.lastProcessedBlock).toBe(26_841_846n);
    expect(state.confirmationDepth).toBeGreaterThan(0);
  });

  it("is idempotent and does not reset progress on a restart", async () => {
    await repos.checkpoints.getOrCreate(CHAIN_ID, STREAM, 26_841_846n);
    await repos.checkpoints.advance({
      chainId: CHAIN_ID,
      stream: STREAM,
      toBlock: 30_000_000n,
      blockHash: MARKER,
    });

    // Worker restarts and calls getOrCreate again with the original start block.
    const afterRestart = await repos.checkpoints.getOrCreate(
      CHAIN_ID,
      STREAM,
      26_841_846n,
    );
    expect(afterRestart.lastProcessedBlock).toBe(30_000_000n);
  });

  it("persists the block hash so a reorg is detectable", async () => {
    await repos.checkpoints.getOrCreate(CHAIN_ID, STREAM, 1n);
    const advanced = await repos.checkpoints.advance({
      chainId: CHAIN_ID,
      stream: STREAM,
      toBlock: 500n,
      blockHash: "0xdeadbeef",
    });
    expect(advanced.lastProcessedBlockHash).toBe("0xdeadbeef");
    expect(advanced.lastSuccessAt).not.toBeNull();
  });

  it("refuses to move backwards outside of an explicit rollback", async () => {
    await repos.checkpoints.getOrCreate(CHAIN_ID, STREAM, 1n);
    await repos.checkpoints.advance({
      chainId: CHAIN_ID,
      stream: STREAM,
      toBlock: 1_000n,
      blockHash: MARKER,
    });

    // An out-of-order worker must not silently cause a re-scan.
    await expect(
      repos.checkpoints.advance({
        chainId: CHAIN_ID,
        stream: STREAM,
        toBlock: 500n,
        blockHash: MARKER,
      }),
    ).rejects.toThrow(/backwards/i);
  });

  it("allows an explicit rollback and clears the orphaned block hash", async () => {
    await repos.checkpoints.getOrCreate(CHAIN_ID, STREAM, 1n);
    await repos.checkpoints.advance({
      chainId: CHAIN_ID,
      stream: STREAM,
      toBlock: 1_000n,
      blockHash: "0xorphan",
    });

    const rolled = await repos.checkpoints.rollbackTo({
      chainId: CHAIN_ID,
      stream: STREAM,
      toBlock: 900n,
      reason: "parent hash mismatch at 1000",
    });

    expect(rolled.lastProcessedBlock).toBe(900n);
    // The hash we held belonged to an orphaned block, so it must not persist.
    expect(rolled.lastProcessedBlockHash).toBeNull();
    expect(rolled.lastError).toMatch(/parent hash mismatch/i);
  });

  it("persists the learned log window size across a restart", async () => {
    await repos.checkpoints.getOrCreate(CHAIN_ID, STREAM, 1n);
    await repos.checkpoints.advance({
      chainId: CHAIN_ID,
      stream: STREAM,
      toBlock: 100n,
      blockHash: MARKER,
      logWindowSize: 37,
    });
    const state = await repos.checkpoints.getOrCreate(CHAIN_ID, STREAM, 1n);
    // Endpoints misreport their real limits, so the working value must survive.
    expect(state.logWindowSize).toBe(37);
  });
});

describeDb("failed block tracking", () => {
  it("counts attempts instead of losing the failure", async () => {
    await repos.checkpoints.recordFailedBlock({
      chainId: CHAIN_ID,
      stream: STREAM,
      blockNumber: 42n,
      error: "RPC timeout",
    });
    await repos.checkpoints.recordFailedBlock({
      chainId: CHAIN_ID,
      stream: STREAM,
      blockNumber: 42n,
      error: "RPC timeout again",
    });

    const failures = await repos.checkpoints.listUnresolvedFailures(CHAIN_ID);
    const ours = failures.filter((f) => f.stream === STREAM);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.attempts).toBe(2);
  });

  it("stops reporting a block once it is resolved", async () => {
    await repos.checkpoints.recordFailedBlock({
      chainId: CHAIN_ID,
      stream: STREAM,
      blockNumber: 43n,
      error: "transient",
    });
    await repos.checkpoints.resolveFailedBlock(CHAIN_ID, STREAM, 43n);

    const failures = await repos.checkpoints.listUnresolvedFailures(CHAIN_ID);
    expect(failures.filter((f) => f.stream === STREAM)).toHaveLength(0);
  });

  it("makes resolution a no-op when a successful scan has no prior failure", async () => {
    // Scanner calls this after every successful range; a missing row is normal, not an
    // exception. `update()` made ordinary successful scans fail after checkpointing.
    await expect(
      repos.checkpoints.resolveFailedBlock(CHAIN_ID, STREAM, 9_999_999n),
    ).resolves.toBeUndefined();
  });

  it("surfaces unresolved failures in the health snapshot", async () => {
    await repos.checkpoints.getOrCreate(CHAIN_ID, STREAM, 1n);
    await repos.checkpoints.recordFailedBlock({
      chainId: CHAIN_ID,
      stream: STREAM,
      blockNumber: 44n,
      error: "still failing",
    });

    const health = await repos.checkpoints.health(CHAIN_ID);
    expect(health.streams.some((s) => s.stream === STREAM)).toBe(true);
    expect(health.unresolvedFailedBlocks).toBeGreaterThan(0);
  });
});
