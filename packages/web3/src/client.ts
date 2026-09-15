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
 */
export function createReadClient(
  endpoints: readonly (string | EndpointConfig)[],
): StunksClient {
  return createStunksClient({
    endpoints,
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
    pool: {
      strategy: "ordered",
      attemptsPerEndpoint: 3,
      timeoutMs: 25_000,
      failureThreshold: 5,
    },
  });
}

export { ROBINHOOD_CHAIN_ID };
