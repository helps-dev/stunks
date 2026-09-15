import type { Address, Hex, PublicClient } from "viem";
import type { Repositories } from "@stunks/database";
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

    const head = await options.source.head();
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

    try {
      const batch = await options.source.getLogs({
        fromBlock,
        toBlock: boundary,
        addresses,
      });

      const reached = batch.reachedBlock;
      if (reached < fromBlock) {
        // The source could not cover even one block. Not fatal, but not progress
        // either — returning early avoids a checkpoint that would skip blocks.
        return {
          scanned: 0n,
          logs: 0,
          fromBlock,
          toBlock: checkpoint.lastProcessedBlock,
          caughtUp: false,
          reorged: false,
        };
      }

      await options.process(batch.logs, { fromBlock, toBlock: reached });

      // Checkpoint to what was reached, with that block's hash so the next tick can
      // detect a reorg.
      const reachedHash = await options.source.blockHash(reached);
      await options.repos.checkpoints.advance({
        chainId: options.chainId,
        stream: options.stream,
        toBlock: reached,
        blockHash: reachedHash,
      });

      return {
        scanned: reached - fromBlock + 1n,
        logs: batch.logs.length,
        fromBlock,
        toBlock: reached,
        caughtUp: reached >= boundary,
        reorged: false,
      };
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

      const message = error instanceof Error ? error.message : String(error);
      await options.repos.checkpoints.recordError(
        options.chainId,
        options.stream,
        message,
      );
      await options.repos.checkpoints.recordFailedBlock({
        chainId: options.chainId,
        stream: options.stream,
        blockNumber: fromBlock,
        error: message,
      });
      throw error;
    }
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

  /** Follow the head indefinitely. */
  async tail(
    intervalMs: number,
    onTick?: (result: ScanTickResult) => void,
  ): Promise<void> {
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
      await sleep(intervalMs);
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
