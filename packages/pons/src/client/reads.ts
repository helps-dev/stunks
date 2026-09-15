import type { Address, PublicClient } from "viem";
import type {
  CurveState,
  FactoryParameters,
  FeePolicySnapshot,
  LaunchConfig,
  LaunchedToken,
  PairTokenEconomics,
} from "@stunks/types";
import { ponsV2FactoryAbi } from "../abi/factory.js";
import { ponsV2CurveAbi } from "../abi/curve.js";
import { ponsV2MemeHookAbi } from "../abi/hook.js";
import { NATIVE_PAIR_TOKEN } from "@stunks/config";
import { parseGraduationPhase } from "../graduation/progress.js";

/** Native ETH is represented as the zero address in `pairToken`. */
export { NATIVE_PAIR_TOKEN };

export function isNativeQuote(pairToken: Address): boolean {
  return pairToken.toLowerCase() === NATIVE_PAIR_TOKEN.toLowerCase();
}

export async function readFactoryParameters(
  client: PublicClient,
  factory: Address,
): Promise<FactoryParameters> {
  const read = <T>(functionName: string) =>
    client.readContract({
      address: factory,
      abi: ponsV2FactoryAbi,
      functionName: functionName as never,
    }) as Promise<T>;

  const [
    launchFee,
    launchEnabled,
    maxCreatorTaxBps,
    snipeTaxStartBps,
    snipeTaxSeconds,
    owner,
  ] = await Promise.all([
    read<bigint>("launchFee"),
    read<boolean>("launchEnabled"),
    read<bigint>("maxCreatorTaxBps"),
    read<bigint>("snipeTaxStartBps"),
    read<bigint>("snipeTaxSeconds"),
    read<Address>("owner"),
  ]);

  return {
    launchFee,
    launchEnabled,
    maxCreatorTaxBps,
    snipeTaxStartBps,
    snipeTaxSeconds,
    owner,
  };
}

/**
 * Read every launch config. `launchConfigCount()` was 1 at audit time but is
 * owner-mutable, so it is read rather than assumed.
 */
export async function readLaunchConfigs(
  client: PublicClient,
  factory: Address,
): Promise<LaunchConfig[]> {
  const count = (await client.readContract({
    address: factory,
    abi: ponsV2FactoryAbi,
    functionName: "launchConfigCount",
  })) as bigint;

  const configs: LaunchConfig[] = [];
  for (let id = 0n; id < count; id++) {
    configs.push(await readLaunchConfig(client, factory, id));
  }
  return configs;
}

export async function readLaunchConfig(
  client: PublicClient,
  factory: Address,
  id: bigint,
): Promise<LaunchConfig> {
  const raw = (await client.readContract({
    address: factory,
    abi: ponsV2FactoryAbi,
    functionName: "getLaunchConfig",
    args: [id],
  })) as {
    supply: bigint;
    curveFeeBps: bigint;
    phantomQuote: bigint;
    graduationThreshold: bigint;
    poolFee: number;
    tickSpacing: number;
    enabled: boolean;
  };

  return {
    id,
    supply: raw.supply,
    curveFeeBps: raw.curveFeeBps,
    phantomQuote: raw.phantomQuote,
    graduationThreshold: raw.graduationThreshold,
    poolFee: raw.poolFee,
    tickSpacing: raw.tickSpacing,
    enabled: raw.enabled,
  };
}

/**
 * The authoritative record for a token. `exists` is the check that an address is
 * genuinely a Pons V2 launch — gate every trading surface on it.
 */
export async function readLaunchedToken(
  client: PublicClient,
  factory: Address,
  token: Address,
): Promise<LaunchedToken> {
  const raw = (await client.readContract({
    address: factory,
    abi: ponsV2FactoryAbi,
    functionName: "getLaunchedToken",
    args: [token],
  })) as {
    token: Address;
    curve: Address;
    deployer: Address;
    creatorFeeRecipient: Address;
    pairToken: Address;
    graduationThreshold: bigint;
    poolFee: number;
    tickSpacing: number;
    creatorTaxBps: number;
    buybackEnabled: boolean;
    phase: number;
    sweptQuote: bigint;
    sweptTokens: bigint;
    sweptAt: bigint;
    exists: boolean;
  };

  return {
    token: raw.token,
    curve: raw.curve,
    deployer: raw.deployer,
    creatorFeeRecipient: raw.creatorFeeRecipient,
    pairToken: raw.pairToken,
    graduationThreshold: raw.graduationThreshold,
    poolFee: raw.poolFee,
    tickSpacing: raw.tickSpacing,
    creatorTaxBps: raw.creatorTaxBps,
    buybackEnabled: raw.buybackEnabled,
    // Throws on an unknown value rather than defaulting, because a wrong phase
    // means a wrong venue.
    phase: parseGraduationPhase(raw.phase),
    sweptQuote: raw.sweptQuote,
    sweptTokens: raw.sweptTokens,
    sweptAt: raw.sweptAt,
    exists: raw.exists,
  };
}

/**
 * Full curve state.
 *
 * Note that `pricingQuoteReserve` and `realQuoteReserve` are read from two
 * different functions and kept as separate fields. At launch the first reads
 * 1.68 ETH (it includes the virtual phantom reserve) and the second reads 0.
 * Interchanging them is a silent pricing bug.
 */
export async function readCurveState(
  client: PublicClient,
  curve: Address,
): Promise<CurveState> {
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: curve,
      abi: ponsV2CurveAbi,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;

  const [
    reserves,
    realQuoteReserve,
    token,
    pairToken,
    phantomQuote,
    reservedTokens,
    sellableTokens,
    graduationThreshold,
    feeBps,
    creatorTaxBps,
    graduated,
    readyToGraduate,
    launchedAt,
    snipeTaxStartBps,
    snipeTaxSeconds,
  ] = await Promise.all([
    read<readonly [bigint, bigint]>("getReserves"),
    read<bigint>("realQuoteReserve"),
    read<Address>("token"),
    read<Address>("pairToken"),
    read<bigint>("phantomQuote"),
    read<bigint>("reservedTokens"),
    read<bigint>("sellableTokens"),
    read<bigint>("graduationThreshold"),
    read<bigint>("feeBps"),
    read<bigint>("creatorTaxBps"),
    read<boolean>("graduated"),
    read<boolean>("readyToGraduate"),
    read<bigint>("launchedAt"),
    read<bigint>("snipeTaxStartBps"),
    read<bigint>("snipeTaxSeconds"),
  ]);

  return {
    curve,
    token,
    pairToken,
    pricingQuoteReserve: reserves[0],
    realQuoteReserve,
    tokenReserve: reserves[1],
    phantomQuote,
    reservedTokens,
    sellableTokens,
    graduationThreshold,
    feeBps,
    creatorTaxBps,
    graduated,
    readyToGraduate,
    launchedAt,
    snipeTaxStartBps,
    snipeTaxSeconds,
  };
}

/** Authoritative per-recipient anti-snipe tax. Prefer this over local computation. */
export async function readCurrentSnipeTaxBps(
  client: PublicClient,
  curve: Address,
  recipient: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: curve,
    abi: ponsV2CurveAbi,
    functionName: "currentSnipeTaxBps",
    args: [recipient],
  })) as bigint;
}

export async function readSnipeTaxExempt(
  client: PublicClient,
  curve: Address,
  account: Address,
): Promise<boolean> {
  return (await client.readContract({
    address: curve,
    abi: ponsV2CurveAbi,
    functionName: "snipeTaxExempt",
    args: [account],
  })) as boolean;
}

/**
 * A launch's frozen fee terms. Display this, not the current global policy: terms
 * are snapshotted at creation so a later policy change cannot alter old launches.
 */
export async function readLaunchFeePolicy(
  client: PublicClient,
  factory: Address,
  token: Address,
): Promise<FeePolicySnapshot> {
  const raw = (await client.readContract({
    address: factory,
    abi: ponsV2FactoryAbi,
    functionName: "getLaunchFeePolicy",
    args: [token],
  })) as {
    protocolFeeRecipient: Address;
    protocolFeeShareBps: number;
    buybackBurnBps: number;
    hookFeeBps: number;
    maxInternalPriceImpactBps: number;
  };
  return raw;
}

/** Current global fee policy, read from the hook (which IS the fee policy). */
export async function readCurrentFeePolicy(
  client: PublicClient,
  memeHook: Address,
): Promise<FeePolicySnapshot> {
  const raw = (await client.readContract({
    address: memeHook,
    abi: ponsV2MemeHookAbi,
    functionName: "currentFeePolicy",
  })) as {
    protocolFeeRecipient: Address;
    protocolFeeShareBps: number;
    buybackBurnBps: number;
    hookFeeBps: number;
    maxInternalPriceImpactBps: number;
  };
  return raw;
}

/**
 * Economics for one approved quote asset.
 *
 * Never derive `graduationThreshold` from `phantomQuote` — the ratio is close to
 * 2.5 but several pairs (MSFT, SNAP, QQQ, BB, F) carry non-round full-precision
 * values, and a derivation drifts in the low decimals.
 */
export async function readPairTokenEconomics(
  client: PublicClient,
  factory: Address,
  pairToken: Address,
): Promise<PairTokenEconomics> {
  const [phantomQuote, graduationThreshold] = (await client.readContract({
    address: factory,
    abi: ponsV2FactoryAbi,
    functionName: "pairTokenEconomics",
    args: [pairToken],
  })) as readonly [bigint, bigint];

  return { pairToken, phantomQuote, graduationThreshold };
}

export async function readPairTokenApproved(
  client: PublicClient,
  factory: Address,
  pairToken: Address,
): Promise<boolean> {
  return (await client.readContract({
    address: factory,
    abi: ponsV2FactoryAbi,
    functionName: "approvedPairTokens",
    args: [pairToken],
  })) as boolean;
}

/**
 * The economics pin for a launch. Always call this and pass the result as
 * `expectedEconomics`; a zero pin lets an owner re-peg land underneath a launch
 * that is already waiting in the user's wallet.
 */
export async function previewLaunchEconomics(
  client: PublicClient,
  factory: Address,
  launchConfigId: bigint,
  pairToken: Address,
): Promise<`0x${string}`> {
  return (await client.readContract({
    address: factory,
    abi: ponsV2FactoryAbi,
    functionName: "previewLaunchEconomics",
    args: [launchConfigId, pairToken],
  })) as `0x${string}`;
}
