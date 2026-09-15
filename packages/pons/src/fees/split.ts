import { applyBps, bigintMin } from "@stunks/utils";
import type { FeePolicySnapshot } from "@stunks/types";

/**
 * Fee split arithmetic, mirroring the curve's `_sweepFees`.
 *
 * Live policy at audit time: protocolFeeShareBps 3000, buybackBurnBps 5000,
 * hookFeeBps 100, maxInternalPriceImpactBps 300.
 *
 * With buyback enabled that works out to protocol 30% / buyback 50% / creator 20%
 * of the base fee, and the creator additionally receives 100% of the creator tax.
 */

export interface FeeSplitInput {
  /** Pending base fee awaiting sweep. */
  readonly pendingFee: bigint;
  /** Pending creator tax. Bypasses the split entirely. */
  readonly pendingCreatorTax: bigint;
  /** Slice of pendingFee earmarked for buyback as each fee was charged. */
  readonly buybackEarmark: bigint;
  readonly protocolFeeShareBps: bigint;
  /**
   * False when the buyback cannot execute — curve too thin, price impact over
   * `maxInternalPriceImpactBps`, or it would eat into `reservedTokens`. In that
   * case the slice folds back into the creator's payout.
   */
  readonly buybackExecutes: boolean;
}

export interface FeeSplitResult {
  readonly protocolAmount: bigint;
  readonly buybackAmount: bigint;
  readonly creatorAmount: bigint;
  /** Always zero for STUNKS. See `platformRevenue` below. */
  readonly platformAmount: bigint;
}

export function computeFeeSplit(input: FeeSplitInput): FeeSplitResult {
  const {
    pendingFee,
    pendingCreatorTax,
    buybackEarmark,
    protocolFeeShareBps,
    buybackExecutes,
  } = input;

  const protocolAmount = applyBps(pendingFee, protocolFeeShareBps);
  const creatorBucket = pendingFee - protocolAmount;

  // The earmark is summed per trade, so its rounding can land a wei or two above
  // the bucket recomputed on the aggregate. The contract clamps; so do we.
  const buybackAmount = buybackExecutes ? bigintMin(buybackEarmark, creatorBucket) : 0n;

  return {
    protocolAmount,
    buybackAmount,
    creatorAmount: creatorBucket - buybackAmount + pendingCreatorTax,
    platformAmount: 0n,
  };
}

/** Total per-trade cost to a trader, in bps, excluding the anti-snipe tax. */
export function totalTradeFeeBps(feeBps: bigint, creatorTaxBps: bigint): bigint {
  return feeBps + creatorTaxBps;
}

/**
 * STUNKS platform revenue.
 *
 * This function returns zero, and that is the correct, verified answer — not a
 * placeholder.
 *
 * The Phase 0 audit read the live fee policy from PonsV2MemeHook and confirmed that
 * no parameter routes any value to STUNKS. Routing a trade through a third-party
 * interface earns that interface nothing under Pons V2. Displaying a non-zero
 * platform revenue would be fabricating income.
 *
 * If a real routing mechanism is ever verified to exist, this is the one place that
 * changes, and it changes together with a deployed adapter — not before.
 */
export function platformRevenue(): { readonly amount: bigint; readonly reason: string } {
  return {
    amount: 0n,
    reason:
      "Pons V2 has no fee route to third-party interfaces. Verified against the live " +
      "fee policy on PonsV2MemeHook. STUNKS earns nothing from Pons trading fees.",
  };
}

/**
 * Read-only analytics seam for a future fee integration. Deliberately has no
 * implementation and no deployed contract behind it: the architecture allows for
 * fee routing later without inventing revenue now.
 */
export interface FeeAdapter {
  getPlatformFees(token: `0x${string}`): Promise<{ amount: bigint; claimable: bigint }>;
  getClaimableFees(): Promise<{ amount: bigint }>;
}

/** Describes a launch's frozen fee terms for display. */
export function describeFeePolicy(snapshot: FeePolicySnapshot): string {
  const protocolPct = snapshot.protocolFeeShareBps / 100;
  const buybackPct = snapshot.buybackBurnBps / 100;
  const hookPct = snapshot.hookFeeBps / 100;
  return (
    `Protocol share ${protocolPct}% of the trade fee, buyback earmark ${buybackPct}%, ` +
    `graduated-pool hook fee ${hookPct}%. Buybacks vest over five years; they are not burned.`
  );
}
