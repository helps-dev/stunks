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

const HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

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
    advance: ReturnType<typeof vi.fn>;
  };
}

function fixture(options: { topics0?: readonly Hex[] } = {}): Fixture {
  const checkpoints = {
    getOrCreate: vi.fn().mockResolvedValue({
      chainId: 4663,
      stream: "factory",
      lastProcessedBlock: 100n,
      lastProcessedBlockHash: null,
      confirmationDepth: 12,
      logWindowSize: 100,
      isPaused: false,
      lastSuccessAt: null,
      lastError: null,
    }),
    recordError: vi.fn().mockResolvedValue(undefined),
    recordFailedBlock: vi.fn().mockResolvedValue(undefined),
    resolveFailedBlock: vi.fn().mockResolvedValue(undefined),
    advance: vi.fn().mockResolvedValue(undefined),
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
    // Reorg cannot run in these tests because the checkpoint has no saved hash.
    // The remaining repositories are unused in a normal tick.
    tokens: {},
    trades: {},
  } as unknown as Repositories;

  return {
    scanner: new Scanner({
      name: "factory",
      stream: "factory",
      chainId: 4663,
      client: {} as never,
      source: source as unknown as LogSource,
      repos,
      startBlock: 100n,
      confirmationDepth: 2,
      addresses: async () => [],
      ...(options.topics0 !== undefined ? { topics0: options.topics0 } : {}),
      process,
      log: vi.fn(),
    }),
    source,
    process,
    checkpoints,
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

  it("resolves a previous failed block after the same range succeeds", async () => {
    const test = fixture();
    await test.scanner.tick();
    expect(test.checkpoints.resolveFailedBlock).toHaveBeenCalledWith(4663, "factory", 101n);
  });
});
