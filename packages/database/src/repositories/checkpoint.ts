import type { PrismaClient } from "@prisma/client";

/**
 * Indexer checkpoints.
 *
 * Two things here are load-bearing:
 *
 * 1. The block HASH is stored alongside the number. Robinhood Chain is an Arbitrum
 *    Orbit L2 and its practical reorg depth is not documented anywhere we could
 *    verify, so the indexer detects a reorg by parent-hash discontinuity rather
 *    than assuming reorgs away.
 *
 * 2. The working `eth_getLogs` window size is persisted. Endpoints disagree about
 *    their real limits and report them misleadingly — one rejected a 500-block
 *    range while claiming the limit was 10,000 — so the value that actually works
 *    is learned at runtime and survives a restart.
 */

export type IndexerStream = "factory" | "curves" | "v4-pool-manager" | "transfers";

export interface CheckpointState {
  readonly chainId: number;
  readonly stream: string;
  readonly lastProcessedBlock: bigint;
  readonly lastProcessedBlockHash: string | null;
  readonly confirmationDepth: number;
  readonly logWindowSize: number;
  readonly isPaused: boolean;
  readonly lastSuccessAt: Date | null;
  readonly lastError: string | null;
}

export class CheckpointRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Read a checkpoint, creating it at `startBlock` if absent.
   *
   * `startBlock` should be the contract's deployment block, not zero: the factory
   * was deployed at 26,841,846 and scanning from genesis would waste 26.8M blocks.
   */
  async getOrCreate(
    chainId: number,
    stream: IndexerStream | string,
    startBlock: bigint,
  ): Promise<CheckpointState> {
    const state = await this.prisma.indexerState.upsert({
      where: { chainId_stream: { chainId, stream } },
      create: { chainId, stream, lastProcessedBlock: startBlock },
      update: {},
    });
    return state;
  }

  /**
   * Advance the checkpoint after a window was processed successfully.
   *
   * Deliberately refuses to move backwards. A rewind must go through
   * `rollbackTo`, so an out-of-order worker cannot silently cause blocks to be
   * re-scanned and rows to be re-derived.
   */
  async advance(args: {
    chainId: number;
    stream: string;
    toBlock: bigint;
    blockHash: string;
    logWindowSize?: number;
  }): Promise<CheckpointState> {
    const current = await this.prisma.indexerState.findUnique({
      where: { chainId_stream: { chainId: args.chainId, stream: args.stream } },
    });

    if (current && current.lastProcessedBlock > args.toBlock) {
      throw new Error(
        `Refusing to move checkpoint backwards for ${args.stream}: at ` +
          `${current.lastProcessedBlock}, asked to set ${args.toBlock}. Use rollbackTo() ` +
          `if a reorg was detected.`,
      );
    }

    return this.prisma.indexerState.update({
      where: { chainId_stream: { chainId: args.chainId, stream: args.stream } },
      data: {
        lastProcessedBlock: args.toBlock,
        lastProcessedBlockHash: args.blockHash,
        lastSuccessAt: new Date(),
        lastError: null,
        ...(args.logWindowSize !== undefined
          ? { logWindowSize: args.logWindowSize }
          : {}),
      },
    });
  }

  /**
   * Rewind after a reorg. The only sanctioned way to move a checkpoint backwards,
   * and it records why.
   */
  async rollbackTo(args: {
    chainId: number;
    stream: string;
    toBlock: bigint;
    reason: string;
  }): Promise<CheckpointState> {
    return this.prisma.indexerState.update({
      where: { chainId_stream: { chainId: args.chainId, stream: args.stream } },
      data: {
        lastProcessedBlock: args.toBlock,
        // Cleared on purpose: the hash we held belonged to an orphaned block.
        lastProcessedBlockHash: null,
        lastError: `Rolled back to ${args.toBlock}: ${args.reason}`,
        lastErrorAt: new Date(),
      },
    });
  }

  /**
   * Skip forward over a range that provably cannot contain anything for this stream.
   *
   * The one legitimate use is the curve stream: a curve cannot emit a trade before it
   * is deployed, so every block before the earliest known launch is guaranteed empty.
   * Scanning them anyway cost ~44 hours of wasted work.
   *
   * Separate from `advance` on purpose. `advance` means "these blocks were processed";
   * this means "these blocks were skipped, and here is why". Conflating them would
   * make it impossible to tell a genuine scan from a shortcut, and the block hash is
   * deliberately left null because nothing was verified.
   */
  async fastForward(args: {
    chainId: number;
    stream: string;
    toBlock: bigint;
    reason: string;
  }): Promise<CheckpointState | null> {
    const current = await this.prisma.indexerState.findUnique({
      where: { chainId_stream: { chainId: args.chainId, stream: args.stream } },
    });
    // Never a rewind, and never a no-op write.
    if (!current || current.lastProcessedBlock >= args.toBlock) return current;

    return this.prisma.indexerState.update({
      where: { chainId_stream: { chainId: args.chainId, stream: args.stream } },
      data: {
        lastProcessedBlock: args.toBlock,
        lastProcessedBlockHash: null,
        lastError: `Fast-forwarded to ${args.toBlock}: ${args.reason}`,
        lastErrorAt: new Date(),
      },
    });
  }

  async recordError(chainId: number, stream: string, error: string): Promise<void> {
    await this.prisma.indexerState.update({
      where: { chainId_stream: { chainId, stream } },
      data: { lastError: error.slice(0, 1000), lastErrorAt: new Date() },
    });
  }

  async setPaused(chainId: number, stream: string, paused: boolean): Promise<void> {
    await this.prisma.indexerState.update({
      where: { chainId_stream: { chainId, stream } },
      data: { isPaused: paused },
    });
  }

  /**
   * Record a block that could not be processed, for bounded retry. A permanently
   * failing block must stay visible rather than being silently skipped.
   */
  async recordFailedBlock(args: {
    chainId: number;
    stream: string;
    blockNumber: bigint;
    error: string;
  }): Promise<void> {
    await this.prisma.failedBlock.upsert({
      where: {
        chainId_stream_blockNumber: {
          chainId: args.chainId,
          stream: args.stream,
          blockNumber: args.blockNumber,
        },
      },
      create: {
        chainId: args.chainId,
        stream: args.stream,
        blockNumber: args.blockNumber,
        lastError: args.error.slice(0, 1000),
      },
      update: {
        attempts: { increment: 1 },
        lastError: args.error.slice(0, 1000),
        resolved: false,
      },
    });
  }

  /**
   * Mark a previously failed block resolved after its range is processed successfully.
   *
   * `updateMany` makes the normal success path safe when no earlier failure exists —
   * avoiding an extra read merely to learn whether cleanup is needed.
   */
  async resolveFailedBlock(
    chainId: number,
    stream: string,
    blockNumber: bigint,
  ): Promise<void> {
    await this.prisma.failedBlock.updateMany({
      where: { chainId, stream, blockNumber, resolved: false },
      data: { resolved: true },
    });
  }

  /**
   * Resolve every historical failed-block record at or below a checkpoint that has
   * since advanced successfully.
   *
   * A checkpoint only moves after processing a complete range, so any failure at or
   * below it has been retried and is no longer an active problem. This repairs health
   * after an outage/restart without hiding a failure ahead of the checkpoint.
   */
  async resolveFailedBlocksThrough(
    chainId: number,
    stream: string,
    throughBlock: bigint,
  ): Promise<number> {
    const result = await this.prisma.failedBlock.updateMany({
      where: {
        chainId,
        stream,
        blockNumber: { lte: throughBlock },
        resolved: false,
      },
      data: { resolved: true },
    });
    return result.count;
  }

  async listUnresolvedFailures(chainId: number, limit = 100) {
    return this.prisma.failedBlock.findMany({
      where: { chainId, resolved: false },
      orderBy: { lastFailedAt: "asc" },
      take: limit,
    });
  }

  /** Health snapshot for the admin dashboard and readiness checks. */
  async health(chainId: number) {
    const [streams, unresolved] = await Promise.all([
      this.prisma.indexerState.findMany({ where: { chainId } }),
      this.prisma.failedBlock.count({ where: { chainId, resolved: false } }),
    ]);
    return { streams, unresolvedFailedBlocks: unresolved };
  }
}
