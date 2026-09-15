import type { Address } from "viem";
import {
  GraduationPhase,
  type LaunchedToken,
  type NoVenueReason,
  type TradingVenue,
} from "@stunks/types";

/**
 * Trading venue resolution.
 *
 * This function is the reason `TradingVenue` has a `NONE` variant. `Swept` is a
 * real, reachable state in which the curve has been drained and trading halted but
 * the Uniswap V4 pool does not exist yet. It is reachable because the curve's
 * `_tryAutoGraduate()` deliberately swallows a failed graduation — emitting
 * `AutoGraduationFailed` — so that a failure there cannot take down the buy that
 * crossed the threshold.
 *
 * A resolver that only asks "graduated or not" will offer trades in that state that
 * always revert. That is the single most likely correctness bug in a trading UI
 * built on this protocol, which is why this is a pure function with exhaustive tests
 * rather than an inline conditional somewhere in a component.
 *
 * Phase must come from a live on-chain read, never from the database.
 */

export interface ResolveVenueArgs {
  readonly launch: LaunchedToken;
  readonly poolManager: Address;
  readonly memeHook: Address;
  /**
   * The pool's currency pair, ordered as Uniswap V4 orders it (currency0 <
   * currency1). Omit when the pool has not been registered on the hook yet.
   */
  readonly poolCurrencies?: { readonly currency0: Address; readonly currency1: Address };
}

export function resolveTradingVenue(args: ResolveVenueArgs): TradingVenue {
  const { launch, poolManager, memeHook, poolCurrencies } = args;

  // A token that is not a Pons V2 launch must never get a trading panel, no matter
  // how much it looks like one.
  if (!launch.exists) {
    return { kind: "NONE", reason: "NOT_A_PONS_LAUNCH" };
  }

  switch (launch.phase) {
    case GraduationPhase.NotGraduated:
      return { kind: "CURVE", curve: launch.curve, pairToken: launch.pairToken };

    case GraduationPhase.Swept:
      // Curve drained, pool pending. No venue. Both `graduate` and
      // `createGraduatedPool` are permissionless, so this is recoverable — but not
      // tradeable right now.
      return { kind: "NONE", reason: "SWEPT_AWAITING_POOL" };

    case GraduationPhase.PoolCreated:
      if (!poolCurrencies) {
        return { kind: "NONE", reason: "POOL_NOT_REGISTERED" };
      }
      return {
        kind: "UNISWAP_V4",
        poolManager,
        hook: memeHook,
        // Snapshotted at launch, so a later config edit cannot move the pool.
        poolFee: launch.poolFee,
        tickSpacing: launch.tickSpacing,
        currency0: poolCurrencies.currency0,
        currency1: poolCurrencies.currency1,
      };

    case GraduationPhase.Rescued:
      return { kind: "NONE", reason: "RESCUED_TERMINAL" };
  }
}

/** User-facing explanation for a missing venue. Never show a bare error. */
export function describeNoVenue(reason: NoVenueReason): string {
  switch (reason) {
    case "SWEPT_AWAITING_POOL":
      return (
        "This token has finished its bonding curve and is waiting for its Uniswap V4 " +
        "pool to be created. Trading will resume once the pool exists. Anyone can " +
        "trigger the remaining step."
      );
    case "RESCUED_TERMINAL":
      return (
        "This launch was rescued manually because its quote asset could not complete " +
        "the pool seeding. It will not graduate and cannot be traded here."
      );
    case "NOT_A_PONS_LAUNCH":
      return "This address is not a Pons V2 launch, so STUNKS cannot trade it.";
    case "POOL_NOT_REGISTERED":
      return (
        "This token has graduated but its pool details have not been indexed yet. " +
        "Trading will be enabled once the pool is confirmed on-chain."
      );
  }
}

/** Uniswap V4 currency ordering: currency0 < currency1, with native ETH as zero. */
export function orderPoolCurrencies(
  tokenA: Address,
  tokenB: Address,
): { currency0: Address; currency1: Address } {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b
    ? { currency0: tokenA, currency1: tokenB }
    : { currency0: tokenB, currency1: tokenA };
}
