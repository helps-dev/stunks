import type { PublicClient } from "viem";

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
 *
 * Bounded so a long backfill cannot grow it without limit.
 */
export class BlockTimeCache {
  private readonly cache = new Map<bigint, Date>();

  constructor(
    private readonly client: PublicClient,
    private readonly maxEntries = 5_000,
  ) {}

  async get(blockNumber: bigint): Promise<Date> {
    const cached = this.cache.get(blockNumber);
    if (cached) return cached;

    const block = await this.client.getBlock({ blockNumber });
    // eslint-disable-next-line no-restricted-syntax -- a unix timestamp is not money; Date requires a number
    const timestamp = new Date(Number(block.timestamp) * 1000);

    // Simple FIFO eviction: access is strictly forward through blocks, so the oldest
    // entry is also the least likely to be needed again.
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(blockNumber, timestamp);
    return timestamp;
  }

  /** Warm several blocks at once, before a batch is processed log by log. */
  async warm(blockNumbers: readonly bigint[]): Promise<void> {
    const missing = [...new Set(blockNumbers)].filter((n) => !this.cache.has(n));
    if (missing.length === 0) return;
    await Promise.all(missing.map((blockNumber) => this.get(blockNumber)));
  }

  size(): number {
    return this.cache.size;
  }
}
