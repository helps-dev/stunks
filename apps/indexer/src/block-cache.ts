import type { PublicClient } from "viem";
import { BatchNotSupportedError } from "@stunks/web3";

/**
 * Reads unix-second timestamps for several blocks in one round trip.
 *
 * Returns one entry per requested block, in the same order.
 */
export type BlockTimestampBatchReader = (
  blockNumbers: readonly bigint[],
) => Promise<readonly bigint[]>;

export interface BlockTimeCacheOptions {
  /** Bounded so a long backfill cannot grow the cache without limit. */
  readonly maxEntries?: number;
  /** Blocks per batched request. */
  readonly batchSize?: number;
  /**
   * Below this many missing blocks, read them individually instead of batching.
   *
   * The factory stream tails the head and needs only a handful of blocks per tick.
   * Those are exactly the blocks a lagging endpoint has not indexed yet, so batching
   * them was measured to fail with BLOCK_UNAVAILABLE on every tick, and the provider
   * that does have them caps batches below that size anyway. Batching is here for the
   * curve stream's wide windows; small requests gain nothing and lose a round trip.
   */
  readonly minBatchSize?: number;
  /** Concurrent single-block reads when batching is unavailable. */
  readonly concurrency?: number;
  readonly readBatch?: BlockTimestampBatchReader;
  readonly log?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Block timestamp cache.
 *
 * Every indexed trade needs its block's timestamp, and a busy launch emits many
 * trades per block. Multicall cannot help here — `eth_getBlockByNumber` is not a
 * contract read — so without a cache the indexer issues one round trip per log.
 *
 * Measured context: launches arrive at roughly 13 per 226 blocks and the chain
 * produces 10 blocks/second, so an uncached lookup per log is enough on its own to
 * keep the indexer permanently behind.
 */
export class BlockTimeCache {
  private readonly cache = new Map<bigint, Date>();
  private readonly maxEntries: number;
  private readonly batchSize: number;
  private readonly minBatchSize: number;
  private readonly concurrency: number;
  private readonly readBatch: BlockTimestampBatchReader | undefined;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;
  /** Set once an endpoint proves it will not serve batches, so it is tried once only. */
  private batchUnsupported = false;

  constructor(
    private readonly client: PublicClient,
    options: BlockTimeCacheOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? 5_000;
    this.batchSize = options.batchSize ?? 100;
    this.minBatchSize = options.minBatchSize ?? 16;
    this.concurrency = options.concurrency ?? 8;
    this.readBatch = options.readBatch;
    this.log = options.log ?? ((): void => {});
  }

  async get(blockNumber: bigint): Promise<Date> {
    const cached = this.cache.get(blockNumber);
    if (cached) return cached;

    const block = await this.client.getBlock({ blockNumber });
    return this.remember(blockNumber, block.timestamp);
  }

  /**
   * Warm several blocks at once, before a batch is processed log by log.
   *
   * This used to be `Promise.all` over every missing block, which is one concurrent
   * request per block with no ceiling. With the curve stream's window reaching
   * thousands of blocks, that burst saturated the RPC pool: dRPC answered
   * RATE_LIMITED, OrdoFi timed out, and the stream stopped advancing for minutes at
   * a time right after the window grew.
   *
   * So the work is batched into single requests where the endpoint supports it, and
   * where it does not, it runs through a small bounded pool instead of a burst.
   * Batching is only an optimisation, so losing it degrades throughput rather than
   * stopping the indexer.
   */
  async warm(blockNumbers: readonly bigint[]): Promise<void> {
    const missing = [...new Set(blockNumbers)].filter((entry) => !this.cache.has(entry));
    if (missing.length === 0) return;

    if (
      this.readBatch !== undefined &&
      !this.batchUnsupported &&
      missing.length >= this.minBatchSize
    ) {
      for (let offset = 0; offset < missing.length; offset += this.batchSize) {
        const chunk = missing.slice(offset, offset + this.batchSize);
        try {
          const timestamps = await this.readBatch(chunk);
          if (timestamps.length !== chunk.length) {
            throw new Error(
              `batch returned ${timestamps.length} timestamps for ${chunk.length} blocks`,
            );
          }
          chunk.forEach((blockNumber, index) => {
            this.remember(blockNumber, timestamps[index]!);
          });
        } catch (error) {
          // Only "no endpoint in the pool serves a batch this size" is permanent. A
          // lagging block or a throttled moment must not cost batching for the rest of
          // the process, which is what an earlier version did.
          if (error instanceof BatchNotSupportedError) this.batchUnsupported = true;
          this.log("block timestamp batching unavailable, falling back to single reads", {
            error: error instanceof Error ? error.message : String(error),
            permanent: this.batchUnsupported,
          });
          break;
        }
      }
    }

    const remaining = missing.filter((entry) => !this.cache.has(entry));
    if (remaining.length === 0) return;

    // A bounded pool, never `Promise.all` over the whole window: the point of this
    // method is to stop one wide window from becoming thousands of simultaneous calls.
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const blockNumber = remaining[index];
        if (blockNumber === undefined) return;
        await this.get(blockNumber);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, remaining.length) }, () =>
        worker(),
      ),
    );
  }

  size(): number {
    return this.cache.size;
  }

  private remember(blockNumber: bigint, unixSeconds: bigint): Date {
    // eslint-disable-next-line no-restricted-syntax -- a unix timestamp is not money; Date requires a number
    const timestamp = new Date(Number(unixSeconds) * 1000);

    // Simple FIFO eviction: access is strictly forward through blocks, so the oldest
    // entry is also the least likely to be needed again.
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(blockNumber, timestamp);
    return timestamp;
  }
}
