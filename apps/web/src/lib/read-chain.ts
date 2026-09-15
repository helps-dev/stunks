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
 */

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
  readonly readAt: string;
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

    const [chainId, block, addresses, parameters, configs] = await Promise.all([
      client.getChainId(),
      client.getBlock(),
      resolvePonsAddresses(client, factory),
      readFactoryParameters(client, factory),
      readLaunchConfigs(client, factory),
    ]);

    const feePolicy = await readCurrentFeePolicy(client, addresses.memeHook);

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
      readAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      endpointsTried: rpcEndpoints,
    };
  }
}
