import type { Address } from "viem";
import { ROBINHOOD_CHAIN_ID } from "./chain.js";

/**
 * The ONLY Pons addresses this project hardcodes.
 *
 * Everything else — meme hook, graduation executor, launch deployer, locker,
 * buyback vault, graduation guard, launch-and-buy router, Uniswap V4 PoolManager
 * and PositionManager, fee escrow — is resolved by calling the factory at runtime
 * (see @stunks/pons `resolvePonsAddresses`).
 *
 * That is not fussiness. The protocol owner can rotate the executor, deployer and
 * forwarder via setGraduationExecutor / setLaunchDeployer / setLaunchForwarder, so
 * a hardcoded list goes stale silently. The audit also found Pons's own published
 * source out of sync with its deployment, so the chain is the only trustworthy
 * description of the system.
 */

/**
 * The zero address, which Pons uses as the sentinel for "native ETH" in
 * `pairToken`. Not a contract address, but it lives here so that the rest of the
 * codebase never needs to write an address literal at all.
 */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Alias that reads better at Pons call sites: `pairToken === NATIVE_PAIR_TOKEN`. */
export const NATIVE_PAIR_TOKEN: Address = ZERO_ADDRESS;

export interface ChainContracts {
  readonly chainId: number;
  /** PonsV2LaunchFactory — the single configured entry point. */
  readonly ponsV2Factory: Address;
  /** Block the factory was deployed at, from binary search over eth_getCode. */
  readonly ponsV2FactoryDeployBlock: bigint;
}

export const CONTRACTS: Record<number, ChainContracts> = {
  [ROBINHOOD_CHAIN_ID]: {
    chainId: ROBINHOOD_CHAIN_ID,
    ponsV2Factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    ponsV2FactoryDeployBlock: 26_841_846n,
  },
};

/**
 * Pons V1 factory, recorded so it can be explicitly recognised and excluded.
 * V1 is a different protocol (day-one Uniswap V3 pool, no bonding curve) and is
 * out of scope for STUNKS V1.
 */
export const PONS_V1_FACTORY: Address = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";

/**
 * ERC-4337 EntryPoints confirmed deployed on Robinhood Chain during the audit.
 * Recorded for a possible future non-custodial multi-signer bundle design; not
 * used in V1.
 */
export const ENTRYPOINTS = {
  v06: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
  v07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  v08: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
} as const satisfies Record<string, Address>;

export function getChainContracts(chainId: number): ChainContracts {
  const contracts = CONTRACTS[chainId];
  if (!contracts) {
    throw new Error(
      `No Pons contract configuration for chain ${chainId}. Supported: ${Object.keys(CONTRACTS).join(", ")}`,
    );
  }
  return contracts;
}
