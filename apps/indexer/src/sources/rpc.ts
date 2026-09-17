import { numberToHex, type Hex, type PublicClient } from "viem";
import { AdaptiveLogWindow, findRpcCallError, type RpcPool } from "@stunks/web3";
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

/** The wire shape of a log, before hex fields are widened to bigint/number. */
interface RawJsonRpcLog {
  readonly address: Address;
  readonly topics: Hex[];
  readonly data: Hex;
  readonly blockNumber: Hex | null;
  readonly blockHash: Hex | null;
  readonly transactionHash: Hex | null;
  readonly logIndex: Hex | null;
}

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

  /**
   * `eth_getLogs` goes through the POOL, not through viem's `getLogs`.
   *
   * viem's `getLogs` derives the `topics` parameter from its own `event`/`events`
   * options and ignores a raw `topics` array. Passing one produced `"topics": []` on
   * the wire — captured directly from the transport — which a node reads as "no
   * filter". The request then returns every log on the chain in the range, and the
   * client-side filter below quietly discards the rest.
   *
   * Measured on 2026-09-17 over 100 blocks: the node returned 4,097 logs, of which 63
   * were Pons curve events. 98.5% of the payload was downloaded and thrown away, on
   * the one resource that constrains this indexer. The same query sent as raw
   * JSON-RPC to the same endpoint returned 17 logs for a single topic, so the node
   * was filtering correctly all along — it was never asked to.
   *
   * Going through the pool also keeps failover, health tracking and the non-JSON
   * detection that a throttled endpoint's HTML error page needs.
   */
  constructor(
    private readonly client: PublicClient,
    initialWindow = 100n,
    private readonly pool?: RpcPool,
  ) {
    this.window = new AdaptiveLogWindow(initialWindow, 10n, 10_000n);
  }

  /** One `eth_getLogs` with the parameters actually intended. */
  private async requestLogs(params: {
    fromBlock: bigint;
    toBlock: bigint;
    addresses: readonly Address[];
    topics0?: readonly Hex[];
  }): Promise<readonly RawJsonRpcLog[]> {
    const filter: Record<string, unknown> = {
      fromBlock: numberToHex(params.fromBlock),
      toBlock: numberToHex(params.toBlock),
    };
    if (params.addresses.length > 0) filter.address = [...params.addresses];
    // Nested on purpose: position 0 of `topics` is topic0, and an array there is an
    // OR over the values. `[a, b]` would instead mean "topic0 = a AND topic1 = b".
    if (params.topics0 !== undefined && params.topics0.length > 0) {
      filter.topics = [[...params.topics0]];
    }

    if (this.pool) return this.pool.request<RawJsonRpcLog[]>("eth_getLogs", [filter]);
    // No pool supplied (tests, and any caller that only has a client). viem's
    // `request` passes the parameters through untouched, unlike its `getLogs`.
    return this.client.request({
      method: "eth_getLogs",
      params: [filter],
    } as never) as Promise<RawJsonRpcLog[]>;
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
      const chunkLogs = new Array<readonly RawJsonRpcLog[]>(chunks.length);
      let nextChunk = 0;
      const readChunk = async (): Promise<void> => {
        for (;;) {
          const index = nextChunk;
          nextChunk += 1;
          const addresses = chunks[index];
          if (addresses === undefined) return;
          chunkLogs[index] = await this.requestLogs({
            fromBlock: query.fromBlock,
            toBlock,
            addresses,
            ...(query.topics0 !== undefined ? { topics0: query.topics0 } : {}),
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
          // Retained even though the node now filters. It costs one comparison per
          // log and it is the thing that would have made the missing server-side
          // filter visible as wasted bandwidth rather than as wrong data — the
          // indexer stayed CORRECT throughout, just expensive. An endpoint that
          // ignores `topics` again is contained here rather than in the processors.
          .filter(
            (log) =>
              query.topics0 === undefined ||
              (log.topics[0] !== undefined && query.topics0.includes(log.topics[0])),
          )
          .map((log) => ({
            address: log.address,
            topics: log.topics,
            data: log.data,
            blockNumber: BigInt(log.blockNumber as Hex),
            blockHash: log.blockHash as Hex,
            transactionHash: log.transactionHash as Hex,
            // eslint-disable-next-line no-restricted-syntax -- a log index is a position, not an amount
            logIndex: Number(BigInt(log.logIndex as Hex)),
          })),
        reachedBlock: toBlock,
      };
    } catch (error) {
      // Unwrapped, because viem wraps whatever the transport throws. Checking
      // `instanceof` on the caught error alone silently never matched, so the window
      // grew on every success and never shrank on a rejection.
      const failure = findRpcCallError(error);

      // A timeout counts as a rejection here. OrdoFi does not refuse an over-wide
      // range, it accepts the request and then never finishes it: a 2,914-block
      // topic-only scan aborted on timeout while the same scan over 100 blocks
      // returned 158 logs immediately. Treating that as merely transient is what let
      // the window sit above what the endpoint could serve indefinitely.
      if (failure?.kind === "LOG_RANGE_TOO_WIDE" || failure?.kind === "TIMEOUT") {
        const narrowed = this.window.onRejected();
        throw new RangeTooWideError(
          toBlock - query.fromBlock + 1n,
          `Endpoint rejected the range (${failure.kind}); window narrowed to ${narrowed}. Retry.`,
        );
      }
      throw error;
    }
  }
}
