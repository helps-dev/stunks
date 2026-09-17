import {
  createPublicClient,
  custom,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";
import { robinhoodChain, ROBINHOOD_CHAIN_ID } from "@stunks/config";
import { RpcPool, type EndpointConfig, type RpcPoolOptions } from "./rpc-pool.js";
import { ChainMismatchError } from "./errors.js";

/**
 * Robinhood Chain produces a block roughly every 101 ms. viem's default receipt
 * polling interval is 4000 ms, which on this chain is longer than the entire
 * 3-second anti-snipe window a launch bundle has to land inside. Every client this
 * project creates therefore polls at 100 ms unless told otherwise.
 */
export const DEFAULT_POLLING_INTERVAL_MS = 100;

export interface StunksClientOptions {
  readonly endpoints: readonly (string | EndpointConfig)[];
  readonly chain?: Chain;
  readonly pollingIntervalMs?: number;
  readonly pool?: RpcPoolOptions;
  /**
   * Batch concurrent `readContract` calls into a single Multicall3 call.
   *
   * This is not a micro-optimisation. Measured on the indexer: reading one launch
   * takes ~20 separate contract reads (launch record, token metadata, full curve
   * state, pair decimals). At ~124 ms per round trip that is ~2.5 s per launch, and
   * with launches arriving at ~13 per 226 blocks the indexer fell steadily further
   * behind a chain that produces 10 blocks/second.
   *
   * Multicall3 is deployed at the canonical address on Robinhood Chain, confirmed
   * during the Phase 0 audit.
   */
  readonly multicall?: boolean;
  /**
   * How long to collect concurrent reads before sending the batch.
   *
   * Short for callers that already issue their reads together through `Promise.all`;
   * longer when independent call sites need to land in the same batch.
   */
  readonly multicallWaitMs?: number;
}

export interface StunksClient {
  readonly client: PublicClient;
  readonly pool: RpcPool;
  /**
   * Asserts the endpoint really is on the expected chain. Call before any write
   * path. Signing against the wrong chain is not a recoverable mistake.
   */
  assertChain(): Promise<void>;
}

/** Wraps an RpcPool as a viem transport so failover applies to every viem call. */
export function poolTransport(pool: RpcPool): Transport {
  return custom({
    async request({ method, params }) {
      return pool.request(method, (params ?? []) as readonly unknown[]);
    },
  });
}

export function createStunksClient(options: StunksClientOptions): StunksClient {
  const chain = options.chain ?? robinhoodChain;
  const pool = new RpcPool(options.endpoints, options.pool);

  const client = createPublicClient({
    chain,
    transport: poolTransport(pool),
    pollingInterval: options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
    ...(options.multicall === true
      ? {
          batch: {
            multicall: {
              // Small window by default: the indexer issues its reads via Promise.all,
              // so they are already concurrent and only need a moment to be collected.
              wait: options.multicallWaitMs ?? 10,
              batchSize: 1_024,
            },
          },
        }
      : {}),
  });

  let verified = false;

  return {
    client,
    pool,
    async assertChain(): Promise<void> {
      if (verified) return;
      const actual = await client.getChainId();
      if (actual !== chain.id) {
        throw new ChainMismatchError(chain.id, actual, "pool");
      }
      verified = true;
    },
  };
}

/**
 * Read-heavy user-facing client: prefer whichever endpoint is currently fastest.
 *
 * Multicall matters MORE here than in the indexer, not less. One render of the landing
 * page resolves the address graph (10 reads), the factory parameters (6), every launch
 * config and the fee policy. Every page is `force-dynamic`, so that whole set runs
 * again on each request, against the same free public endpoints the indexer depends on
 * — an uncached page was the cheapest way to exhaust the RPC budget the indexer needs.
 *
 * The batching window is wider than the indexer's 10 ms because these reads are issued
 * by several independent server components rather than one `Promise.all`, so they need
 * slightly longer to be collected into the same call.
 */
export function createReadClient(
  endpoints: readonly (string | EndpointConfig)[],
): StunksClient {
  return createStunksClient({
    endpoints,
    multicall: true,
    multicallWaitMs: 40,
    pool: { strategy: "fastest", attemptsPerEndpoint: 2, timeoutMs: 10_000 },
  });
}

/**
 * Indexer client: deterministic endpoint order and more patience, because
 * reproducibility matters more than latency when writing canonical state.
 */
export function createIndexerClient(
  endpoints: readonly (string | EndpointConfig)[],
): StunksClient {
  return createStunksClient({
    endpoints,
    // Without this the indexer cannot keep pace with the chain: see the note on
    // `multicall` above for the measurement.
    multicall: true,
    pool: {
      strategy: "ordered",
      attemptsPerEndpoint: 3,
      timeoutMs: 25_000,
      failureThreshold: 5,
    },
  });
}

export { ROBINHOOD_CHAIN_ID };
