import { describe, expect, it } from "vitest";
import { computeFeeSplit, platformRevenue, totalTradeFeeBps } from "./split.js";

/**
 * Fee split against the live policy read during the audit:
 * protocolFeeShareBps 3000, buybackBurnBps 5000, hookFeeBps 100.
 */

const PROTOCOL_SHARE_BPS = 3_000n;

describe("fee split with buyback enabled", () => {
  it("splits 30 / 50 / 20 across protocol, buyback and creator", () => {
    const pendingFee = 1_000_000_000_000_000_000n; // 1 ETH of accrued fee
    const result = computeFeeSplit({
      pendingFee,
      pendingCreatorTax: 0n,
      // The earmark accrues at buybackBurnBps (5000) of each fee.
      buybackEarmark: pendingFee / 2n,
      protocolFeeShareBps: PROTOCOL_SHARE_BPS,
      buybackExecutes: true,
    });

    expect(result.protocolAmount).toBe(300_000_000_000_000_000n);
    expect(result.buybackAmount).toBe(500_000_000_000_000_000n);
    expect(result.creatorAmount).toBe(200_000_000_000_000_000n);
    expect(result.protocolAmount + result.buybackAmount + result.creatorAmount).toBe(
      pendingFee,
    );
  });

  it("pays the creator tax entirely to the creator, outside the split", () => {
    const result = computeFeeSplit({
      pendingFee: 1_000_000_000_000_000_000n,
      pendingCreatorTax: 2_000_000_000_000_000_000n,
      buybackEarmark: 500_000_000_000_000_000n,
      protocolFeeShareBps: PROTOCOL_SHARE_BPS,
      buybackExecutes: true,
    });
    // 20% of the fee plus 100% of the tax.
    expect(result.creatorAmount).toBe(2_200_000_000_000_000_000n);
    // The protocol takes nothing from the tax.
    expect(result.protocolAmount).toBe(300_000_000_000_000_000n);
  });
});

describe("buyback fold-back", () => {
  it("folds the buyback slice into the creator payout when it cannot execute", () => {
    const pendingFee = 1_000_000_000_000_000_000n;
    const result = computeFeeSplit({
      pendingFee,
      pendingCreatorTax: 0n,
      buybackEarmark: pendingFee / 2n,
      protocolFeeShareBps: PROTOCOL_SHARE_BPS,
      // Curve too thin, or the buyback would breach maxInternalPriceImpactBps.
      buybackExecutes: false,
    });
    expect(result.buybackAmount).toBe(0n);
    expect(result.creatorAmount).toBe(700_000_000_000_000_000n);
    expect(result.protocolAmount).toBe(300_000_000_000_000_000n);
  });

  it("clamps an earmark that rounded above the creator bucket", () => {
    // The earmark is summed per trade, so aggregate rounding can push it a wei or
    // two past the bucket. The contract clamps; so must we.
    const pendingFee = 1_000n;
    const result = computeFeeSplit({
      pendingFee,
      pendingCreatorTax: 0n,
      buybackEarmark: 999_999n,
      protocolFeeShareBps: PROTOCOL_SHARE_BPS,
      buybackExecutes: true,
    });
    expect(result.buybackAmount).toBe(700n);
    expect(result.creatorAmount).toBe(0n);
    expect(result.protocolAmount).toBe(300n);
  });

  it("never lets the split exceed what was collected", () => {
    const pendingFee = 7n; // deliberately awkward, to exercise truncation
    const result = computeFeeSplit({
      pendingFee,
      pendingCreatorTax: 3n,
      buybackEarmark: 3n,
      protocolFeeShareBps: PROTOCOL_SHARE_BPS,
      buybackExecutes: true,
    });
    expect(result.protocolAmount + result.buybackAmount + result.creatorAmount).toBe(
      pendingFee + 3n,
    );
  });
});

describe("total trade fee", () => {
  it("adds the base fee and creator tax — 3% on the live example curve", () => {
    expect(totalTradeFeeBps(100n, 200n)).toBe(300n);
  });
});

describe("platform revenue", () => {
  it("is zero, and that is a verified answer rather than a placeholder", () => {
    const revenue = platformRevenue();
    expect(revenue.amount).toBe(0n);
    expect(revenue.reason).toMatch(/no fee route/i);
  });

  it("is never included in a fee split", () => {
    const result = computeFeeSplit({
      pendingFee: 1_000_000_000_000_000_000n,
      pendingCreatorTax: 5_000_000_000_000_000_000n,
      buybackEarmark: 500_000_000_000_000_000n,
      protocolFeeShareBps: PROTOCOL_SHARE_BPS,
      buybackExecutes: true,
    });
    expect(result.platformAmount).toBe(0n);
  });
});
