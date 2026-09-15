import type { Address, Hex } from "viem";

/**
 * On-chain graduation phase. Numeric values match the Solidity enum exactly:
 *
 *   enum GraduationPhase { NotGraduated, Swept, PoolCreated, Rescued }
 *
 * `Swept` is the one that catches people out. The curve has been drained and
 * trading halted, but the Uniswap V4 pool does not exist yet, so the token has
 * NO tradeable venue. It is reachable because the curve's auto-graduation
 * deliberately swallows failure (emitting AutoGraduationFailed) rather than
 * reverting the buy that crossed the threshold.
 */
export enum GraduationPhase {
  NotGraduated = 0,
  Swept = 1,
  PoolCreated = 2,
  Rescued = 3,
}

/** Trade direction. Fees are always charged on the quote leg either way. */
export type TradeSide = "BUY" | "SELL";

/**
 * Where a trade can actually execute right now, derived from live on-chain
 * phase — never from the database.
 *
 * `NONE` is a first-class outcome, not an error. A venue resolver that only
 * distinguishes "graduated or not" will route users into transactions that
 * always revert.
 */
export type TradingVenue =
  | { readonly kind: "CURVE"; readonly curve: Address; readonly pairToken: Address }
  | {
      readonly kind: "UNISWAP_V4";
      readonly poolManager: Address;
      readonly hook: Address;
      readonly poolFee: number;
      readonly tickSpacing: number;
      readonly currency0: Address;
      readonly currency1: Address;
    }
  | { readonly kind: "NONE"; readonly reason: NoVenueReason };

export type NoVenueReason =
  | "SWEPT_AWAITING_POOL"
  | "RESCUED_TERMINAL"
  | "NOT_A_PONS_LAUNCH"
  | "POOL_NOT_REGISTERED";

/**
 * `getLaunchConfig(id)` on PonsV2LaunchFactory.
 *
 * Live values for config 0 at audit time: supply 1e27, curveFeeBps 100,
 * phantomQuote 1.68e18, graduationThreshold 4.2e18, poolFee 0, tickSpacing 200.
 * Read them; never hardcode them.
 */
export interface LaunchConfig {
  readonly id: bigint;
  readonly supply: bigint;
  readonly curveFeeBps: bigint;
  readonly phantomQuote: bigint;
  readonly graduationThreshold: bigint;
  readonly poolFee: number;
  readonly tickSpacing: number;
  readonly enabled: boolean;
}

/** `getLaunchedToken(token)` on PonsV2LaunchFactory. */
export interface LaunchedToken {
  readonly token: Address;
  readonly curve: Address;
  readonly deployer: Address;
  readonly creatorFeeRecipient: Address;
  readonly pairToken: Address;
  readonly graduationThreshold: bigint;
  /** Snapshotted at launch, so a later config edit cannot move the pool. */
  readonly poolFee: number;
  readonly tickSpacing: number;
  readonly creatorTaxBps: number;
  readonly buybackEnabled: boolean;
  readonly phase: GraduationPhase;
  readonly sweptQuote: bigint;
  readonly sweptTokens: bigint;
  readonly sweptAt: bigint;
  /** False means this address is not a Pons V2 launch. Gate all trading UI on it. */
  readonly exists: boolean;
}

/**
 * Fee terms frozen for one launch at creation. A later global policy change does
 * not alter existing launches, so always display the launch's own snapshot rather
 * than the current global policy.
 */
export interface FeePolicySnapshot {
  readonly protocolFeeRecipient: Address;
  readonly protocolFeeShareBps: number;
  readonly buybackBurnBps: number;
  readonly hookFeeBps: number;
  readonly maxInternalPriceImpactBps: number;
}

/**
 * Live curve state.
 *
 * The two quote reserves are deliberately separate fields and must never be
 * swapped. At launch `pricingQuoteReserve` reads 1.68 ETH (it includes the
 * virtual phantom reserve) while `realQuoteReserve` reads 0.
 */
export interface CurveState {
  readonly curve: Address;
  readonly token: Address;
  readonly pairToken: Address;
  /** phantomQuote + trackedQuote - pendingFees. Use for PRICING. */
  readonly pricingQuoteReserve: bigint;
  /** trackedQuote - pendingFees. Real assets only. Use for GRADUATION PROGRESS. */
  readonly realQuoteReserve: bigint;
  readonly tokenReserve: bigint;
  readonly phantomQuote: bigint;
  readonly reservedTokens: bigint;
  readonly sellableTokens: bigint;
  readonly graduationThreshold: bigint;
  readonly feeBps: bigint;
  readonly creatorTaxBps: bigint;
  readonly graduated: boolean;
  readonly readyToGraduate: boolean;
  readonly launchedAt: bigint;
  readonly snipeTaxStartBps: bigint;
  readonly snipeTaxSeconds: bigint;
}

/** Factory-level parameters. All owner-mutable, so read them live. */
export interface FactoryParameters {
  readonly launchFee: bigint;
  readonly launchEnabled: boolean;
  readonly maxCreatorTaxBps: bigint;
  readonly snipeTaxStartBps: bigint;
  readonly snipeTaxSeconds: bigint;
  readonly owner: Address;
}

/**
 * Pons addresses. Only `factory` is configured; the rest are resolved by calling
 * the factory, because the protocol owner can rotate the executor, deployer and
 * router. Note the naming traps found during the audit: the locker getter is
 * `locker()` not `launchLocker()`, there is no `feePolicy()` on the factory, and
 * the meme hook IS the fee policy.
 */
export interface PonsAddresses {
  readonly factory: Address;
  readonly memeHook: Address;
  readonly graduationExecutor: Address;
  readonly launchDeployer: Address;
  readonly locker: Address;
  readonly buybackVault: Address;
  readonly graduationGuard: Address;
  readonly launchAndBuyRouter: Address;
  readonly poolManager: Address;
  readonly positionManager: Address;
  readonly feeEscrow: Address;
}

/** Economics for one approved quote asset, from `pairTokenEconomics(token)`. */
export interface PairTokenEconomics {
  readonly pairToken: Address;
  readonly phantomQuote: bigint;
  readonly graduationThreshold: bigint;
}

/** Params for `launchToken` / `launchAndBuy`. Field order matters for encoding. */
export interface TokenLaunchParams {
  readonly name: string;
  readonly symbol: string;
  readonly logo: string;
  readonly description: string;
  readonly socials: readonly [string, string, string, string, string];
  readonly creatorFeeRecipient: Address;
  readonly creatorTaxBps: number;
  readonly buybackEnabled: boolean;
  /**
   * Pin from `previewLaunchEconomics(configId, pairToken)`. Zero waives the
   * check and lets an owner re-peg land underneath an in-flight launch, so
   * STUNKS always sets it.
   */
  readonly expectedEconomics: Hex;
  /** CREATE2 salt, namespaced per initiating account. */
  readonly salt: Hex;
}
