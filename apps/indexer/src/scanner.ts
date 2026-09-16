import type { Address, Hex, PublicClient } from "viem";
import { isDatabaseAvailabilityError, type Repositories } from "@stunks/database";
import { checkForReorg, safeHead } from "./reorg.js";
import { RangeTooWideError, type LogSource, type RawLog } from "./sources/types.js";

/**
 * The scan loop.
 *
 * Four properties this is built to guarantee, each one learned from measurement:
 *
 * 1. It checkpoints to the block the source ACTUALLY reached, never to the block it
 *    asked for. Both sources can return less than requested — HyperSync paginates,
 *    and the RPC window narrows itself on rejection — and trusting the request would
 *    silently skip blocks.
 *
 * 2. It only processes below a confirmation depth, and verifies the recorded block
 *    hash before advancing. This chain's practical reorg depth is undocumented, so
 *    divergence is detected rather than assumed away. At ~101 ms per block, a
 *    12-block delay costs about a second.
 *
 * 3. A too-wide range is retried after narrowing, not counted as a failure. The
 *    endpoint is fine; the request was wrong.
 *
 * 4. A block that genuinely cannot be processed is recorded as a failed block, so it
 *    stays visible instead of being skipped past forever.
 */

export type ProcessLogs = (
  logs: readonly RawLog[],
  range: { fromBlock: bigint; toBlock: bigint },
) => Promise<void>;

export interface ScannerOptions {
  readonly name: string;
  readonly stream: string;
  readonly chainId: number;
  readonly client: PublicClient;
  readonly source: LogSource;
  readonly repos: Repositories;
  readonly startBlock: bigint;
  readonly confirmationDepth: number;
  /** Addresses to filter on. A function, because the curve set grows as tokens launch. */
  readonly addresses: () => Promise<readonly Address[]>;
  /** Optional OR-filter for event topic0 values, applied by the RPC node. */
  readonly topics0?: readonly Hex[];
  /** Skip the query entirely when the address set is empty and a filter is required. */
  readonly requireAddresses?: boolean;
  /**
   * Optional ceiling, evaluated every tick.
   *
   * The curve stream uses this to stay at or behind the factory checkpoint. Without
   * it the two streams have to run sequentially — and since the indexer currently
   * moves slower than the chain head, "factory first, to completion" never finishes
   * and the curve stream never starts at all. That produced a real deadlock: 716
   * tokens indexed and zero trades.
   */
  readonly maxBlock?: () => Promise<bigint | null>;
  readonly process: ProcessLogs;
  readonly log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ScanTickResult {
  readonly scanned: bigint;
  readonly logs: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly caughtUp: boolean;
  readonly reorged: boolean;
}

export class Scanner {
  private stopping = false;

  constructor(private readonly options: ScannerOptions) {}

  stop(): void {
    this.stopping = true;
  }

  /**
   * One scan step. Returns `caughtUp` when there is nothing left below the
   * confirmation boundary, which is the signal for the caller to switch from
   * backfill to tailing.
   */
  async tick(): Promise<ScanTickResult> {
    const { options } = this;

    const checkpoint = await options.repos.checkpoints.getOrCreate(
      options.chainId,
      options.stream,
      options.startBlock,
    );

    if (checkpoint.isPaused) {
      return {
        scanned: 0n,
        logs: 0,
        fromBlock: checkpoint.lastProcessedBlock,
        toBlock: checkpoint.lastProcessedBlock,
        caughtUp: true,
        reorged: false,
      };
    }

    // Reorg check before anything else. Processing logs on top of a history that no
    // longer exists is worse than doing nothing.
    const reorged = await this.handleReorg(
      checkpoint.lastProcessedBlock,
      checkpoint.lastProcessedBlockHash,
    );
    if (reorged) {
      return {
        scanned: 0n,
        logs: 0,
        fromBlock: checkpoint.lastProcessedBlock,
        toBlock: checkpoint.lastProcessedBlock,
        caughtUp: false,
        reorged: true,
      };
    }

    let head: bigint;
    try {
      head = await options.source.head();
    } catch (error) {
      // A provider failing to state its head says nothing about the block at the
      // checkpoint. Preserve it, wait, and ask again; never create a failed-block row.
      return this.handleSourceFailure(
        checkpoint.lastProcessedBlock,
        checkpoint.lastProcessedBlock,
        error,
      );
    }
    const confirmed = safeHead(head, options.confirmationDepth);

    // A dependent stream cannot run past the stream it depends on.
    let boundary = confirmed;
    if (boundary !== null && options.maxBlock) {
      const ceiling = await options.maxBlock();
      if (ceiling === null) {
        boundary = null;
      } else if (ceiling < boundary) {
        boundary = ceiling;
      }
    }

    if (boundary === null || boundary <= checkpoint.lastProcessedBlock) {
      return {
        scanned: 0n,
        logs: 0,
        fromBlock: checkpoint.lastProcessedBlock,
        toBlock: checkpoint.lastProcessedBlock,
        caughtUp: true,
        reorged: false,
      };
    }

    const fromBlock = checkpoint.lastProcessedBlock + 1n;
    const addresses = await options.addresses();

    // An empty required filter would become "every log on the chain", which at
    // ~852,912 blocks/day is not something to do by accident.
    if (options.requireAddresses === true && addresses.length === 0) {
      return {
        scanned: 0n,
        logs: 0,
        fromBlock,
        toBlock: checkpoint.lastProcessedBlock,
        caughtUp: true,
        reorged: false,
      };
    }

    let batch;
    try {
      batch = await options.source.getLogs({
        fromBlock,
        toBlock: boundary,
        addresses,
        ...(options.topics0 !== undefined ? { topics0: options.topics0 } : {}),
      });
    } catch (error) {
      if (error instanceof RangeTooWideError) {
        // The endpoint is healthy; the request was too ambitious. Retry next tick
        // with the narrowed window rather than recording a failure.
        options.log("log range narrowed, retrying", {
          stream: options.stream,
          attempted: error.attempted.toString(),
        });
        return {
          scanned: 0n,
          logs: 0,
          fromBlock,
          toBlock: checkpoint.lastProcessedBlock,
          caughtUp: false,
          reorged: false,
        };
      }
      return this.handleSourceFailure(fromBlock, checkpoint.lastProcessedBlock, error);
    }

    const reached = batch.reachedBlock;
    if (reached < fromBlock) {
      // The source could not cover even one block. Not fatal, but not progress either
      // — returning early avoids a checkpoint that would skip blocks.
      return {
        scanned: 0n,
        logs: 0,
        fromBlock,
        toBlock: checkpoint.lastProcessedBlock,
        caughtUp: false,
        reorged: false,
      };
    }

    // Read the hash BEFORE calling the processor. A multi-provider RPC pool can let
    // one endpoint report a head that another has not indexed yet. If the hash read
    // fails after processing, idempotency keeps data correct on retry but needlessly
    // replays the entire window. Before processing, no write occurs at all.
    let reachedHash: string;
    try {
      reachedHash = await options.source.blockHash(reached);
    } catch (error) {
      return this.handleSourceFailure(fromBlock, checkpoint.lastProcessedBlock, error);
    }

    try {
      await options.process(batch.logs, { fromBlock, toBlock: reached });
    } catch (error) {
      if (isDatabaseAvailabilityError(error)) {
        // A failed Neon connection says nothing about this block's logs. The batch may
        // even have partially written idempotent rows before the outage; retrying from
        // the unchanged checkpoint is safe and must not leave a permanent false
        // failed-block row.
        return this.handleDatabaseFailure(fromBlock, checkpoint.lastProcessedBlock, error);
      }
      // The processor reached a concrete log range and could not make sense of it.
      // Keep this block visible for diagnosis and bounded retry.
      const message = error instanceof Error ? error.message : String(error);
      await options.repos.checkpoints.recordError(options.chainId, options.stream, message);
      await options.repos.checkpoints.recordFailedBlock({
        chainId: options.chainId,
        stream: options.stream,
        blockNumber: fromBlock,
        error: message,
      });
      throw error;
    }

    try {
      await options.repos.checkpoints.advance({
        chainId: options.chainId,
        stream: options.stream,
        toBlock: reached,
        blockHash: reachedHash,
      });
      // A successful range proves all older failed-block records in this stream were
      // retried. Clear them through the new checkpoint so historical transient RPC or
      // database outages cannot keep health degraded forever.
      await options.repos.checkpoints.resolveFailedBlocksThrough(
        options.chainId,
        options.stream,
        reached,
      );
    } catch (error) {
      if (isDatabaseAvailabilityError(error)) {
        return this.handleDatabaseFailure(fromBlock, checkpoint.lastProcessedBlock, error);
      }
      // Database/checkpoint failures are infrastructure incidents, not bad chain
      // blocks. Surface and retry them without poisoning the failed-block table.
      const message = error instanceof Error ? error.message : String(error);
      await options.repos.checkpoints.recordError(options.chainId, options.stream, message);
      throw error;
    }

    return {
      scanned: reached - fromBlock + 1n,
      logs: batch.logs.length,
      fromBlock,
      toBlock: reached,
      caughtUp: reached >= boundary,
      reorged: false,
    };
  }

  /**
   * Database availability is different from a bad decoded block. Do not attempt to
   * write `lastError` while the database itself is down — that write would fail too
   * and turn a retryable outage into a noisy tail exception. The process log carries
   * the diagnostic; the unchanged checkpoint carries the recovery point.
   */
  private async handleDatabaseFailure(
    fromBlock: bigint,
    lastProcessedBlock: bigint,
    error: unknown,
  ): Promise<ScanTickResult> {
    const message = error instanceof Error ? error.message : String(error);
    this.options.log("database unavailable, retaining checkpoint", {
      stream: this.options.stream,
      fromBlock: fromBlock.toString(),
      error: message,
    });
    return {
      scanned: 0n,
      logs: 0,
      fromBlock,
      toBlock: lastProcessedBlock,
      caughtUp: false,
      reorged: false,
    };
  }

  /**
   * Record a temporary source problem without claiming a chain block is bad.
   *
   * A pool can legitimately have providers at different heads. Returning no progress
   * makes backfill use its existing backoff and tail try again next interval, both from
   * the unchanged checkpoint.
   */
  private async handleSourceFailure(
    fromBlock: bigint,
    lastProcessedBlock: bigint,
    error: unknown,
  ): Promise<ScanTickResult> {
    const message = error instanceof Error ? error.message : String(error);
    await this.options.repos.checkpoints.recordError(
      this.options.chainId,
      this.options.stream,
      message,
    );
    this.options.log("source unavailable, retaining checkpoint", {
      stream: this.options.stream,
      fromBlock: fromBlock.toString(),
      source: this.options.source.name,
      error: message,
    });
    return {
      scanned: 0n,
      logs: 0,
      fromBlock,
      toBlock: lastProcessedBlock,
      caughtUp: false,
      reorged: false,
    };
  }

  /** Run until caught up. Returns the number of blocks covered. */
  async backfill(onProgress?: (result: ScanTickResult) => void): Promise<bigint> {
    let total = 0n;
    for (;;) {
      if (this.stopping) break;
      const result = await this.tick();
      total += result.scanned;
      onProgress?.(result);
      if (result.caughtUp) break;
      // A tick that made no progress and did not report catching up means the source
      // is struggling. Back off rather than spin.
      if (result.scanned === 0n && !result.reorged) {
        await sleep(1_000);
      }
    }
    return total;
  }

  /**
   * Follow the head indefinitely.
   *
   * The interval may be a function, re-evaluated after every tick. Two streams share
   * one RPC pool here, and the free endpoints for this chain are the scarce resource:
   * dRPC answers `RATE_LIMITED` and OrdoFi `UPSTREAM_UNAVAILABLE` once both streams
   * poll hard. A caller that knows one stream has slack can therefore hand back
   * budget to the other instead of both spending it evenly.
   */
  async tail(
    intervalMs: number | (() => number),
    onTick?: (result: ScanTickResult) => void,
  ): Promise<void> {
    const nextInterval = typeof intervalMs === "function" ? intervalMs : () => intervalMs;
    while (!this.stopping) {
      try {
        const result = await this.tick();
        onTick?.(result);
      } catch (error) {
        this.options.log("tail tick failed", {
          stream: this.options.stream,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(nextInterval());
    }
  }

  private async handleReorg(
    recordedBlock: bigint,
    recordedHash: string | null,
  ): Promise<boolean> {
    if (recordedHash === null || recordedBlock <= 0n) return false;

    let currentHash: Hex;
    try {
      currentHash = await this.options.source.blockHash(recordedBlock);
    } catch {
      // Cannot verify right now. Doing nothing is correct: the alternative is
      // rolling back on the strength of an RPC hiccup.
      return false;
    }

    const verdict = checkForReorg(
      { recordedHash, recordedBlock, currentHash },
      this.options.confirmationDepth,
    );

    if (verdict.kind !== "REORG") return false;

    this.options.log("REORG detected", {
      stream: this.options.stream,
      atBlock: recordedBlock.toString(),
      recordedHash: verdict.recordedHash,
      currentHash: verdict.currentHash,
      rollbackTo: verdict.rollbackTo.toString(),
    });

    // Delete first, then move the checkpoint. If this crashes in between, the
    // checkpoint still points above the deletion and the blocks are re-scanned —
    // which is safe, because every write is idempotent. The reverse order could
    // leave orphaned rows below a rewound checkpoint.
    const deletedTrades = await this.options.repos.trades.deleteAboveBlock(
      this.options.chainId,
      verdict.rollbackTo,
    );
    const deletedTokens = await this.options.repos.tokens.deleteAboveBlock(
      this.options.chainId,
      verdict.rollbackTo,
    );

    await this.options.repos.checkpoints.rollbackTo({
      chainId: this.options.chainId,
      stream: this.options.stream,
      toBlock: verdict.rollbackTo,
      reason: `hash mismatch at ${recordedBlock}`,
    });

    this.options.log("rollback complete", {
      stream: this.options.stream,
      deletedTrades,
      deletedTokens,
    });

    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
