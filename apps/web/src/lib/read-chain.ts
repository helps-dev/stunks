import {
  getChainContracts,
  KNOWN_RPC_ENDPOINTS,
  ROBINHOOD_CHAIN_ID,
} from "@stunks/config";
import { createReadClient } from "@stunks/web3";
import {
  readCurrentFeePolicy,
  readFactoryParameters,
  readLaunchConfigs,
  computeReservedTokens,
  resolvePonsAddresses,
  platformRevenue,
} from "@stunks/pons";
import type {
  FactoryParameters,
  FeePolicySnapshot,
  LaunchConfig,
  PonsAddresses,
} from "@stunks/types";

/**
 * Server-side read of live Pons state for the proof-of-read page.
 *
 * The point of this page is to demonstrate that the foundation genuinely talks to
 * Robinhood Chain. So there is no fallback data: if the chain cannot be reached, the
 * page says so rather than rendering something plausible.
 *
 * WHAT IS CACHED, AND WHY THAT IS NOT A FALLBACK
 *
 * Two kinds of value are read here and they do not change at the same rate:
 *
 *   head block, timestamp   every ~101 ms, read fresh on every request
 *   protocol graph, params  only when the protocol owner changes them
 *
 * Every page is `force-dynamic`, so before this the second group was re-read on each
 * request too: the address graph (10 reads), factory parameters (6), one read per
 * launch config, and the fee policy. All of it against the same free public endpoints
 * the indexer needs, with no rate limit in front of the page — refreshing the landing
 * page was the cheapest way to starve the indexer.
 *
 * Multicall3 collapses each group into one round trip; this TTL then stops the
 * slow-moving group being re-read at all for a minute. It is a cache of a real read,
 * never a substitute for one: a cold or expired entry does the work, a failure is
 * never cached, and `readAt` reports when the values were actually fetched so the page
 * states its own age rather than implying it is live.
 */

/** Owner-mutable, but not per-block. Drift of up to a minute is visible in `readAt`. */
const PROTOCOL_CACHE_TTL_MS = 60_000;

interface ProtocolState {
  readonly addresses: PonsAddresses;
  readonly parameters: FactoryParameters;
  readonly configs: readonly LaunchConfig[];
  readonly feePolicy: FeePolicySnapshot;
  readonly factory: `0x${string}`;
  readonly readAt: number;
}

let protocolCache: ProtocolState | null = null;

/**
 * Read the slow-moving protocol state, reusing a recent read when there is one.
 *
 * Keyed on the factory address so a configuration change can never be served from a
 * cache built against the previous one.
 */
async function readProtocolState(
  client: Parameters<typeof resolvePonsAddresses>[0],
  factory: `0x${string}`,
  now: number,
): Promise<ProtocolState> {
  const cached = protocolCache;
  if (
    cached !== null &&
    cached.factory === factory &&
    now - cached.readAt < PROTOCOL_CACHE_TTL_MS
  ) {
    return cached;
  }

  const [addresses, parameters, configs] = await Promise.all([
    resolvePonsAddresses(client, factory),
    readFactoryParameters(client, factory),
    readLaunchConfigs(client, factory),
  ]);
  const feePolicy = await readCurrentFeePolicy(client, addresses.memeHook);

  // Only a complete, successful read is cached. A failure propagates and the next
  // request tries again rather than being handed a stale answer it did not ask for.
  const fresh: ProtocolState = {
    addresses,
    parameters,
    configs,
    feePolicy,
    factory,
    readAt: now,
  };
  protocolCache = fresh;
  return fresh;
}

export interface ChainSnapshot {
  readonly ok: true;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly endpoint: string;
  readonly factory: `0x${string}`;
  readonly factoryDeployBlock: bigint;
  readonly addresses: PonsAddresses;
  readonly parameters: FactoryParameters;
  readonly configs: readonly LaunchConfig[];
  readonly feePolicy: FeePolicySnapshot;
  readonly reservedTokensByConfig: readonly bigint[];
  readonly platformRevenue: { amount: bigint; reason: string };
  /** When the head block was read. Always this request. */
  readonly readAt: string;
  /** When the protocol graph and parameters were last actually fetched. */
  readonly protocolReadAt: string;
}

export interface ChainSnapshotError {
  readonly ok: false;
  readonly message: string;
  readonly endpointsTried: readonly string[];
}

function endpoints(): string[] {
  const configured = process.env.NEXT_PUBLIC_RPC_ENDPOINTS ?? process.env.RPC_ENDPOINTS;
  if (configured) {
    return configured
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  // Fall back to endpoints verified during the audit rather than failing to boot.
  return [KNOWN_RPC_ENDPOINTS.drpc, KNOWN_RPC_ENDPOINTS.ordofi];
}

export async function readChainSnapshot(): Promise<ChainSnapshot | ChainSnapshotError> {
  const rpcEndpoints = endpoints();

  try {
    const { client, assertChain } = createReadClient(rpcEndpoints);

    // Refuse to render anything if the endpoint is not on the expected chain.
    await assertChain();

    const contracts = getChainContracts(ROBINHOOD_CHAIN_ID);
    const factory =
      (process.env.NEXT_PUBLIC_PONS_V2_FACTORY as `0x${string}` | undefined) ??
      contracts.ponsV2Factory;

    const now = Date.now();
    // The head is always read fresh; the protocol state may be served from a recent
    // read. They are requested together so a cold cache still costs one round trip.
    const [chainId, block, protocol] = await Promise.all([
      client.getChainId(),
      client.getBlock(),
      readProtocolState(client, factory, now),
    ]);

    const { addresses, parameters, configs, feePolicy } = protocol;

    return {
      ok: true,
      chainId,
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      endpoint: rpcEndpoints[0] ?? "unknown",
      factory,
      factoryDeployBlock: contracts.ponsV2FactoryDeployBlock,
      addresses,
      parameters,
      configs,
      feePolicy,
      reservedTokensByConfig: configs.map((config) =>
        computeReservedTokens(
          config.supply,
          config.phantomQuote,
          config.graduationThreshold,
        ),
      ),
      platformRevenue: platformRevenue(),
      // When the head was read. The protocol values may be up to a minute older;
      // `protocolReadAt` says exactly how old rather than letting this imply they are
      // the same age.
      readAt: new Date(now).toISOString(),
      protocolReadAt: new Date(protocol.readAt).toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      endpointsTried: rpcEndpoints,
    };
  }
}
