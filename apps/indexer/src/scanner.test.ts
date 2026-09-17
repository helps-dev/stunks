import { describe, expect, it, vi } from "vitest";
import type { Repositories } from "@stunks/database";
import type { Hex } from "viem";
import { Scanner } from "./scanner.js";
import { RangeTooWideError, type LogSource } from "./sources/types.js";

/**
 * Scanner resilience tests.
 *
 * Public Robinhood RPC providers do not share an exactly synchronized view of head. One
 * can return H from eth_blockNumber while another answers "Block at number H-12 could
 * not be found" for eth_getBlock or eth_getLogs. That is a temporary source problem,
 * not evidence that the checkpoint block is permanently bad.
 *
 * These tests protect the boundary that matters:
 *
 *   source unavailable -> checkpoint unchanged, error visible, retry same range
 *   processor failed   -> checkpoint unchanged, failed block visible, retry same range
 *
 * Conflating those states produced permanent false failed-block rows and kept health
 * degraded even after the next retry succeeded.
 */

const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

interface Fixture {
  readonly scanner: Scanner;
  readonly source: {
    head: ReturnType<typeof vi.fn>;
    getLogs: ReturnType<typeof vi.fn>;
    blockHash: ReturnType<typeof vi.fn>;
  };
  readonly process: ReturnType<typeof vi.fn>;
  readonly checkpoints: {
    getOrCreate: ReturnType<typeof vi.fn>;
    recordError: ReturnType<typeof vi.fn>;
    recordFailedBlock: ReturnType<typeof vi.fn>;
    resolveFailedBlock: ReturnType<typeof vi.fn>;
    resolveFailedBlocksThrough: ReturnType<typeof vi.fn>;
    advance: ReturnType<typeof vi.fn>;
    rollbackTo: ReturnType<typeof vi.fn>;
    rollbackIfAhead: ReturnType<typeof vi.fn>;
  };
  readonly deleteAbove: ReturnType<typeof vi.fn>;
}

interface FixtureOptions {
  readonly topics0?: readonly Hex[];
  readonly stream?: string;
  /** Set to replay a checkpoint whose recorded hash no longer matches the chain. */
  readonly recordedHash?: Hex | null;
  readonly cascadeStreams?: readonly string[];
}

function fixture(options: FixtureOptions = {}): Fixture {
  const stream = options.stream ?? "factory";
  const checkpoints = {
    getOrCreate: vi.fn().mockResolvedValue({
      chainId: 4663,
      stream,
      lastProcessedBlock: 100n,
      lastProcessedBlockHash: options.recordedHash ?? null,
      confirmationDepth: 12,
      logWindowSize: 100,
      isPaused: false,
      lastSuccessAt: null,
      lastError: null,
    }),
    recordError: vi.fn().mockResolvedValue(undefined),
    recordFailedBlock: vi.fn().mockResolvedValue(undefined),
    resolveFailedBlock: vi.fn().mockResolvedValue(undefined),
    resolveFailedBlocksThrough: vi.fn().mockResolvedValue(0),
    advance: vi.fn().mockResolvedValue(undefined),
    rollbackTo: vi.fn().mockResolvedValue(undefined),
    rollbackIfAhead: vi.fn().mockResolvedValue(null),
  };

  const source = {
    name: "rpc",
    head: vi.fn().mockResolvedValue(105n),
    getLogs: vi.fn().mockResolvedValue({ logs: [], reachedBlock: 103n }),
    blockHash: vi.fn().mockResolvedValue(HASH),
  };
  const process = vi.fn().mockResolvedValue(undefined);

  const repos = {
    checkpoints,
    // A stream deletes only what it owns, through `deleteAbove`. The scanner never
    // reaches for a repository directly during a rollback, which is the point.
    tokens: {},
    trades: {},
  } as unknown as Repositories;

  const deleteAbove = vi.fn().mockResolvedValue({ tokens: 7 });

  return {
    scanner: new Scanner({
      name: stream,
      stream,
      chainId: 4663,
      client: {} as never,
      source: source as unknown as LogSource,
      repos,
      startBlock: 100n,
      confirmationDepth: 2,
      addresses: async () => [],
      ...(options.topics0 !== undefined ? { topics0: options.topics0 } : {}),
      ...(options.cascadeStreams !== undefined
        ? { cascadeStreams: options.cascadeStreams }
        : {}),
      deleteAbove,
      process,
      log: vi.fn(),
    }),
    source,
    process,
    checkpoints,
    deleteAbove,
  };
}

describe("Scanner source errors", () => {
  it("passes an event-topic OR filter through to the log source", async () => {
    const topics = [
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ] as const;
    const test = fixture({ topics0: topics });

    await test.scanner.tick();

    expect(test.source.getLogs).toHaveBeenCalledWith({
      fromBlock: 101n,
      toBlock: 103n,
      addresses: [],
      topics0: topics,
    });
  });

  it("keeps the checkpoint when a provider has not indexed the confirmed block", async () => {
    const test = fixture();
    test.source.getLogs.mockRejectedValueOnce(
      new Error('Block at number "103" could not be found.'),
    );

    await expect(test.scanner.tick()).resolves.toMatchObject({
      scanned: 0n,
      fromBlock: 101n,
      toBlock: 100n,
      caughtUp: false,
    });
    expect(test.process).not.toHaveBeenCalled();
    expect(test.checkpoints.advance).not.toHaveBeenCalled();
    expect(test.checkpoints.recordError).toHaveBeenCalledOnce();
    // Critical: this is an endpoint lag, not a permanently bad chain block.
    expect(test.checkpoints.recordFailedBlock).not.toHaveBeenCalled();

    // On recovery the scanner retries exactly the same range; it never skips ahead.
    await test.scanner.tick();
    expect(test.source.getLogs).toHaveBeenLastCalledWith({
      fromBlock: 101n,
      toBlock: 103n,
      addresses: [],
    });
    expect(test.checkpoints.advance).toHaveBeenCalledWith(
      expect.objectContaining({ toBlock: 103n, blockHash: HASH }),
    );
  });

  it("does not process a window when its reached-block hash is unavailable", async () => {
    const test = fixture();
    test.source.blockHash.mockRejectedValueOnce(
      new Error('Block at number "103" could not be found.'),
    );

    await expect(test.scanner.tick()).resolves.toMatchObject({ scanned: 0n });
    // Hash verification happens before the processor, avoiding an unnecessary replay.
    expect(test.process).not.toHaveBeenCalled();
    expect(test.checkpoints.advance).not.toHaveBeenCalled();
    expect(test.checkpoints.recordFailedBlock).not.toHaveBeenCalled();
  });

  it("treats an unavailable head as temporary and preserves the same checkpoint", async () => {
    const test = fixture();
    test.source.head.mockRejectedValueOnce(new Error("temporary RPC outage"));

    await expect(test.scanner.tick()).resolves.toMatchObject({
      scanned: 0n,
      fromBlock: 100n,
      toBlock: 100n,
      caughtUp: false,
    });
    expect(test.source.getLogs).not.toHaveBeenCalled();
    expect(test.checkpoints.recordFailedBlock).not.toHaveBeenCalled();
  });

  it("treats a temporary database outage as retryable rather than a failed block", async () => {
    const test = fixture();
    test.process.mockRejectedValueOnce(
      new Error("Timed out fetching a new connection from the connection pool"),
    );

    await expect(test.scanner.tick()).resolves.toMatchObject({
      scanned: 0n,
      fromBlock: 101n,
      toBlock: 100n,
      caughtUp: false,
    });
    expect(test.checkpoints.recordError).not.toHaveBeenCalled();
    expect(test.checkpoints.recordFailedBlock).not.toHaveBeenCalled();
    expect(test.checkpoints.advance).not.toHaveBeenCalled();
  });

  it("still treats a processing failure as a failed block", async () => {
    const test = fixture();
    test.process.mockRejectedValueOnce(new Error("event decode invariant violated"));

    await expect(test.scanner.tick()).rejects.toThrow(/event decode invariant violated/);
    expect(test.checkpoints.recordFailedBlock).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 101n }),
    );
    expect(test.checkpoints.advance).not.toHaveBeenCalled();
  });

  it("does not record a failed block while narrowing an oversized range", async () => {
    const test = fixture();
    test.source.getLogs.mockRejectedValueOnce(
      new RangeTooWideError(100n, "window was rejected"),
    );

    await expect(test.scanner.tick()).resolves.toMatchObject({ scanned: 0n });
    expect(test.checkpoints.recordError).not.toHaveBeenCalled();
    expect(test.checkpoints.recordFailedBlock).not.toHaveBeenCalled();
  });

  it("resolves every old failed block through a successful checkpoint", async () => {
    const test = fixture();
    await test.scanner.tick();
    expect(test.checkpoints.resolveFailedBlocksThrough).toHaveBeenCalledWith(
      4663,
      "factory",
      103n,
    );
  });
});

/**
 * Reorg rollback, and the coupling it used to have.
 *
 * Deletions are chain-scoped; a checkpoint is per stream. The two do not commute. The
 * old code had every stream delete both tokens and trades across the whole chain while
 * rewinding only its own checkpoint. Because the curve stream trails the factory by
 * design — 715,288 blocks on 2026-09-17 — a rollback on the curve stream erased tokens
 * the factory had already indexed above the rollback point, and the factory checkpoint
 * stayed put and never re-scanned them. Those launches were gone for good.
 *
 * The rule these tests hold in place: delete only what this stream wrote, then pull
 * back any stream that the deletion left standing above the rollback point.
 */
describe("Scanner reorg rollback", () => {
  const DIVERGED =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;

  it("deletes only the rows this stream owns", async () => {
    // Confirmation depth 2, checkpoint 100 -> rollback target 98.
    const test = fixture({ recordedHash: DIVERGED, stream: "curves" });

    await expect(test.scanner.tick()).resolves.toMatchObject({
      reorged: true,
      scanned: 0n,
    });

    expect(test.deleteAbove).toHaveBeenCalledWith(98n);
    expect(test.checkpoints.rollbackTo).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 4663, stream: "curves", toBlock: 98n }),
    );
    // Nothing was processed on top of a history that no longer exists.
    expect(test.process).not.toHaveBeenCalled();
    expect(test.checkpoints.advance).not.toHaveBeenCalled();
  });

  it("does not touch another stream when it has nothing to cascade to", async () => {
    const test = fixture({ recordedHash: DIVERGED, stream: "curves" });
    await test.scanner.tick();
    expect(test.checkpoints.rollbackIfAhead).not.toHaveBeenCalled();
  });

  it("pulls dependent streams back so they cannot claim deleted blocks", async () => {
    const test = fixture({
      recordedHash: DIVERGED,
      stream: "factory",
      cascadeStreams: ["curves"],
    });

    await test.scanner.tick();

    expect(test.checkpoints.rollbackIfAhead).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 4663, stream: "curves", toBlock: 98n }),
    );
  });

  it("leaves a dependent stream alone when it is already below the rollback point", async () => {
    const test = fixture({
      recordedHash: DIVERGED,
      stream: "factory",
      cascadeStreams: ["curves"],
    });
    // This is what `rollbackIfAhead` answers for a stream that is already behind.
    test.checkpoints.rollbackIfAhead.mockResolvedValue(null);

    await expect(test.scanner.tick()).resolves.toMatchObject({ reorged: true });

    // Asked, and correctly declined — never forced backwards.
    expect(test.checkpoints.rollbackIfAhead).toHaveBeenCalledOnce();
    expect(test.checkpoints.rollbackTo).toHaveBeenCalledOnce();
  });

  it("deletes before moving the checkpoint, so a crash between them re-scans", async () => {
    const order: string[] = [];
    const test = fixture({ recordedHash: DIVERGED, stream: "curves" });
    test.deleteAbove.mockImplementation(async () => {
      order.push("delete");
      return { trades: 3 };
    });
    test.checkpoints.rollbackTo.mockImplementation(async () => {
      order.push("rollback");
    });

    await test.scanner.tick();

    expect(order).toEqual(["delete", "rollback"]);
  });

  it("does not roll back on an unverifiable hash read", async () => {
    const test = fixture({ recordedHash: DIVERGED, stream: "curves" });
    test.source.blockHash.mockRejectedValueOnce(new Error("temporary RPC outage"));

    await expect(test.scanner.tick()).resolves.toMatchObject({ reorged: false });
    expect(test.deleteAbove).not.toHaveBeenCalled();
    expect(test.checkpoints.rollbackTo).not.toHaveBeenCalled();
  });

  it("does not roll back when the recorded hash still matches", async () => {
    const test = fixture({ recordedHash: HASH, stream: "curves" });

    await expect(test.scanner.tick()).resolves.toMatchObject({ reorged: false });
    expect(test.deleteAbove).not.toHaveBeenCalled();
    expect(test.checkpoints.rollbackTo).not.toHaveBeenCalled();
  });
});
