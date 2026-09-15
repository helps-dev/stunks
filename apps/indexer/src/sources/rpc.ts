import type { Hex, PublicClient } from "viem";
import { AdaptiveLogWindow, RpcCallError } from "@stunks/web3";
import type { Address } from "viem";
import {
  RangeTooWideError,
  type LogBatch,
  type LogQuery,
  type LogSource,
} from "./types.js";

/**
 * Smallest verified address-selector cap among the providers in the pool.
 *
 * OrdoFi rejects a query with 1,001 addresses ("only 1000 are allowed"). The curve
 * stream has thousands of dynamically deployed contracts, so a single address array
 * works only until it suddenly does not. Split at the lowest known cap; every chunk
 * covers the same block range, so their union is complete and no block is skipped.
 */
export const MAX_LOG_ADDRESSES_PER_QUERY = 1_000;

/** Split an eth_getLogs address filter without changing its block range. */
function addressChunks(
  addresses: readonly Address[],
  topicSelectorCount: number,
): readonly (readonly Address[])[] {
  if (addresses.length === 0) return [[]];
  // OrdoFi counts every OR-ed address and topic selector against the same cap. A
  // curve scan has seven relevant topic0 values, so 1,000 addresses plus those topics
  // would still be rejected as 1,007 selectors. One address is always retained even
  // if a future event list somehow exceeds the provider cap; that query then fails
  // visibly rather than silently dropping a topic.
  const addressesPerChunk = Math.max(1, MAX_LOG_ADDRESSES_PER_QUERY - topicSelectorCount);
  const chunks: Address[][] = [];
  for (let offset = 0; offset < addresses.length; offset += addressesPerChunk) {
    chunks.push(addresses.slice(offset, offset + addressesPerChunk));
  }
  return chunks;
}

/**
 * Two concurrent address groups shorten a 9,000-curve scan without bursting every
 * request through a public RPC endpoint at once. The pool still handles rate limits and
 * failover; this limit merely keeps one logical scan from monopolising it.
 */
export const MAX_CONCURRENT_LOG_ADDRESS_QUERIES = 2;

/**
 * RPC log source.
 *
 * Suitable for live tailing, where each tick covers a handful of blocks. NOT
 * suitable for backfill: the widest window a free endpoint accepted was 100 blocks,
 * which puts a full 36.8M-block backfill at ~51 hours.
 *
 * The window size is adaptive because endpoints misreport their own limits. One
 * rejected a 250-block range while its error message claimed the limit was 10,000.
 * So the working value is discovered by halving on rejection, and it is persisted in
 * the checkpoint so a restart does not have to relearn it.
 */
export class RpcLogSource implements LogSource {
  readonly name = "rpc";
  private readonly window: AdaptiveLogWindow;

  constructor(
    private readonly client: PublicClient,
    initialWindow = 100n,
  ) {
    this.window = new AdaptiveLogWindow(initialWindow, 10n, 10_000n);
  }

  /** Current window size, so the scanner can persist it. */
  windowSize(): bigint {
    return this.window.current();
  }

  async head(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async blockHash(blockNumber: bigint): Promise<Hex> {
    const block = await this.client.getBlock({ blockNumber });
    return block.hash;
  }

  async getLogs(query: LogQuery): Promise<LogBatch> {
    // Clamp the request to what this endpoint currently tolerates. The scanner asks
    // for what it wants; the source answers with what it could actually deliver.
    const requested = query.toBlock - query.fromBlock + 1n;
    const allowed = this.window.current();
    const toBlock = requested > allowed ? query.fromBlock + allowed - 1n : query.toBlock;

    try {
      // A provider cap applies to address selectors as well as block range. Run each
      // address chunk against exactly the same block range, then combine the results.
      // A small worker pool prevents 9,000 curves from becoming either nine fully
      // sequential requests (too slow) or nine simultaneous public-RPC bursts (too
      // throttle-prone).
      const chunks = addressChunks(query.addresses, query.topics0?.length ?? 0);
      const chunkLogs = new Array<Awaited<ReturnType<PublicClient["getLogs"]>>>(
        chunks.length,
      );
      let nextChunk = 0;
      const readChunk = async (): Promise<void> => {
        for (;;) {
          const index = nextChunk;
          nextChunk += 1;
          const addresses = chunks[index];
          if (addresses === undefined) return;
          chunkLogs[index] = await this.client.getLogs({
            ...(addresses.length > 0 ? { address: [...addresses] } : {}),
            ...(query.topics0 !== undefined ? { topics: [query.topics0] } : {}),
            fromBlock: query.fromBlock,
            toBlock,
          });
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(MAX_CONCURRENT_LOG_ADDRESS_QUERIES, chunks.length) },
          () => readChunk(),
        ),
      );
      const logs = chunkLogs.flat();

      this.window.onSuccess();

      return {
        logs: logs
          .filter(
            (log) =>
              log.blockNumber !== null &&
              log.blockHash !== null &&
              log.transactionHash !== null &&
              log.logIndex !== null,
          )
          .filter(
            (log) =>
              query.topics0 === undefined ||
              (log.topics[0] !== undefined && query.topics0.includes(log.topics[0])),
          )
          .map((log) => ({
            address: log.address,
            topics: log.topics,
            data: log.data,
            blockNumber: log.blockNumber as bigint,
            blockHash: log.blockHash as Hex,
            transactionHash: log.transactionHash as Hex,
            logIndex: log.logIndex as number,
          })),
        reachedBlock: toBlock,
      };
    } catch (error) {
      if (error instanceof RpcCallError && error.kind === "LOG_RANGE_TOO_WIDE") {
        const narrowed = this.window.onRejected();
        throw new RangeTooWideError(
          toBlock - query.fromBlock + 1n,
          `Endpoint rejected the range; window narrowed to ${narrowed}. Retry.`,
        );
      }
      throw error;
    }
  }
}
