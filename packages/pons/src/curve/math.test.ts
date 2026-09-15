import { describe, expect, it } from "vitest";
import {
  SnipeTaxNotModellableError,
  computeCurveBuy,
  computeCurveSell,
  computePriceImpactBps,
  computeReservedTokens,
  getAmountIn,
  getAmountOut,
  quoteAmountOut,
} from "./math.js";
import { requiresSimulation } from "./snipe-tax.js";

/**
 * The regression suite that protects the core of the trading engine.
 *
 * The vectors in `verified mainnet vectors` were captured during the Phase 0 audit
 * by running eth_call against a live Pons V2 curve and recording the exact result.
 * If these ever fail, either the protocol changed or someone introduced a float —
 * both are stop-work conditions, not test flakes.
 *
 * Source curve: 0xe0d8C6a8c6F4aEA8e86A613FFB5545cC9372d87A (token TIKI)
 * State at capture: pricing reserves 1.68 ETH / 1e27 tokens, feeBps 100,
 * creatorTaxBps 200, snipe window already expired.
 */

const TIKI = {
  pricingQuoteReserve: 1_680_000_000_000_000_000n,
  tokenReserve: 1_000_000_000_000_000_000_000_000_000n,
  feeBps: 100n,
  creatorTaxBps: 200n,
  reservedTokens: 285_714_285_714_285_714_285_714_285n,
} as const;

describe("verified mainnet vectors", () => {
  const vectors = [
    {
      label: "0.01 ETH",
      quoteIn: 10_000_000_000_000_000n,
      expected: 5_740_664_023_199_384_506_125_347n,
    },
    {
      label: "0.1 ETH",
      quoteIn: 100_000_000_000_000_000n,
      expected: 54_586_381_541_924_592_009_003_939n,
    },
    {
      label: "1 ETH",
      quoteIn: 1_000_000_000_000_000_000n,
      expected: 366_037_735_849_056_603_773_584_905n,
    },
  ];

  for (const vector of vectors) {
    it(`reproduces the on-chain result exactly for ${vector.label}`, () => {
      const result = computeCurveBuy({
        quoteIn: vector.quoteIn,
        pricingQuoteReserve: TIKI.pricingQuoteReserve,
        tokenReserve: TIKI.tokenReserve,
        feeBps: TIKI.feeBps,
        creatorTaxBps: TIKI.creatorTaxBps,
        reservedTokens: TIKI.reservedTokens,
      });

      // Exact equality, to the wei. Not a tolerance.
      expect(result.tokensOut).toBe(vector.expected);
      expect(result.partialFill).toBe(false);
      expect(result.refund).toBe(0n);
      expect(result.spent).toBe(vector.quoteIn);
    });
  }

  it("charges 1% fee and 2% creator tax on the input leg", () => {
    const result = computeCurveBuy({
      quoteIn: 1_000_000_000_000_000_000n,
      pricingQuoteReserve: TIKI.pricingQuoteReserve,
      tokenReserve: TIKI.tokenReserve,
      feeBps: TIKI.feeBps,
      creatorTaxBps: TIKI.creatorTaxBps,
      reservedTokens: TIKI.reservedTokens,
    });
    expect(result.feeAmount).toBe(10_000_000_000_000_000n);
    expect(result.creatorTaxAmount).toBe(20_000_000_000_000_000n);
    expect(result.snipeTaxAmount).toBe(0n);
  });
});

describe("reservedTokens derivation", () => {
  it("matches the on-chain reservedTokens() byte for byte", () => {
    // Verified against the chain: config 0 supply 1e27, phantomQuote 1.68e18,
    // graduationThreshold 4.2e18.
    const reserved = computeReservedTokens(
      1_000_000_000_000_000_000_000_000_000n,
      1_680_000_000_000_000_000n,
      4_200_000_000_000_000_000n,
    );
    expect(reserved).toBe(285_714_285_714_285_714_285_714_285n);
  });

  it("holds the 28.57% / 71.43% split the protocol targets", () => {
    const supply = 1_000_000_000_000_000_000_000_000_000n;
    const reserved = computeReservedTokens(
      supply,
      1_680_000_000_000_000_000n,
      4_200_000_000_000_000_000n,
    );
    // 2857 bps of supply, floor.
    expect((reserved * 10_000n) / supply).toBe(2857n);
  });

  it("rejects degenerate economics rather than dividing by zero", () => {
    expect(() => computeReservedTokens(1n, 0n, 0n)).toThrow(/degenerate/i);
  });
});

describe("constant product primitives", () => {
  it("getAmountOut floors, matching Solidity truncation", () => {
    // 1 in, reserves 3/7: 1*7/(3+1) = 1.75 -> 1
    expect(getAmountOut(1n, 3n, 7n)).toBe(1n);
  });

  it("getAmountIn adds one wei, matching the library", () => {
    const reserveIn = 1_000_000n;
    const reserveOut = 1_000_000n;
    const amountOut = 1000n;
    const amountIn = getAmountIn(amountOut, reserveIn, reserveOut);
    // Round-trip must not under-deliver.
    expect(getAmountOut(amountIn, reserveIn, reserveOut)).toBeGreaterThanOrEqual(
      amountOut,
    );
  });

  it("quoteAmountOut returns zero where getAmountOut throws", () => {
    expect(quoteAmountOut(0n, 1n, 1n)).toBe(0n);
    expect(quoteAmountOut(1n, 0n, 1n)).toBe(0n);
    expect(() => getAmountOut(0n, 1n, 1n)).toThrow();
  });

  it("rejects zero liquidity instead of returning a plausible number", () => {
    expect(() => getAmountOut(1n, 0n, 100n)).toThrow(/liquidity/i);
    expect(() => getAmountOut(1n, 100n, 0n)).toThrow(/liquidity/i);
  });
});

describe("partial fill against reservedTokens", () => {
  it("clamps rather than reverting, and reports a refund", () => {
    // A buy far larger than the sellable allocation.
    const result = computeCurveBuy({
      quoteIn: 1_000_000_000_000_000_000_000n, // 1000 ETH
      pricingQuoteReserve: TIKI.pricingQuoteReserve,
      tokenReserve: TIKI.tokenReserve,
      feeBps: TIKI.feeBps,
      creatorTaxBps: TIKI.creatorTaxBps,
      reservedTokens: TIKI.reservedTokens,
    });

    expect(result.partialFill).toBe(true);
    // Never sells into the graduated pool's allocation.
    expect(result.tokensOut).toBe(TIKI.tokenReserve - TIKI.reservedTokens);
    expect(result.spent).toBeLessThan(1_000_000_000_000_000_000_000n);
    expect(result.refund).toBeGreaterThan(0n);
    expect(result.spent + result.refund).toBe(1_000_000_000_000_000_000_000n);
  });

  it("recomputes fees on the clamped spend, not the offered amount", () => {
    const result = computeCurveBuy({
      quoteIn: 1_000_000_000_000_000_000_000n,
      pricingQuoteReserve: TIKI.pricingQuoteReserve,
      tokenReserve: TIKI.tokenReserve,
      feeBps: TIKI.feeBps,
      creatorTaxBps: TIKI.creatorTaxBps,
      reservedTokens: TIKI.reservedTokens,
    });
    expect(result.feeAmount).toBe((result.spent * TIKI.feeBps) / 10_000n);
    expect(result.creatorTaxAmount).toBe((result.spent * TIKI.creatorTaxBps) / 10_000n);
  });

  it("throws when the sellable allocation is already exhausted", () => {
    expect(() =>
      computeCurveBuy({
        quoteIn: 1_000_000n,
        pricingQuoteReserve: TIKI.pricingQuoteReserve,
        tokenReserve: TIKI.reservedTokens,
        feeBps: TIKI.feeBps,
        creatorTaxBps: TIKI.creatorTaxBps,
        reservedTokens: TIKI.reservedTokens,
      }),
    ).toThrow(/sellable/i);
  });
});

describe("snipe tax", () => {
  /**
   * These two cases encode a real boundary discovered by re-deriving the audit's
   * measurements. Both come from the same 0.05 ETH buy at Rq 1.68e18 / Rt 1e27:
   *
   *   exempt recipient      net 48499999999999999   ->  300 bps deducted
   *   non-exempt, age 1 s   net 45409999999999999   ->  918 bps deducted  (100+200+618)
   *   non-exempt, age 0 s   net   499999999999999   -> 9900 bps deducted  (NOT 10200)
   *
   * So deductions are additive while the total stays under 100%, and at age 0 the
   * result is exactly snipeTaxBps. How the contract reconciles an over-100% total is
   * not verified, so the model declines that regime instead of guessing.
   */

  it("is additive while the total stays under 100% (verified age 1s vector)", () => {
    const result = computeCurveBuy({
      quoteIn: 50_000_000_000_000_000n,
      pricingQuoteReserve: TIKI.pricingQuoteReserve,
      tokenReserve: TIKI.tokenReserve,
      feeBps: TIKI.feeBps,
      creatorTaxBps: TIKI.creatorTaxBps,
      snipeTaxBps: 618n, // 9900 >> 4, the value at age 1s
      reservedTokens: TIKI.reservedTokens,
    });

    // Exactly the amount measured on-chain for a non-whitelisted recipient at age 1s.
    expect(result.tokensOut).toBe(26_318_382_297_540_874_342_909_801n);
  });

  it("declines to model an over-100% total instead of guessing", () => {
    expect(() =>
      computeCurveBuy({
        quoteIn: 50_000_000_000_000_000n,
        pricingQuoteReserve: TIKI.pricingQuoteReserve,
        tokenReserve: TIKI.tokenReserve,
        feeBps: TIKI.feeBps, // 100
        creatorTaxBps: TIKI.creatorTaxBps, // 200
        snipeTaxBps: 9_900n, // total 10200 bps — real on-chain state at age 0
        reservedTokens: TIKI.reservedTokens,
      }),
    ).toThrow(SnipeTaxNotModellableError);
  });

  it("the declined case is exactly the one requiresSimulation() catches", () => {
    // age 0 of a 3-second window, non-exempt recipient.
    expect(
      requiresSimulation({
        launchedAt: 1_000n,
        windowSeconds: 3n,
        nowSeconds: 1_000n,
        recipientExempt: false,
      }),
    ).toBe(true);
    // A whitelisted recipient never enters the unmodellable regime.
    expect(
      requiresSimulation({
        launchedAt: 1_000n,
        windowSeconds: 3n,
        nowSeconds: 1_000n,
        recipientExempt: true,
      }),
    ).toBe(false);
  });
});

describe("sell", () => {
  it("takes the fee from the output, after pricing", () => {
    const tokensIn = 1_000_000_000_000_000_000_000_000n;
    const result = computeCurveSell({
      tokensIn,
      pricingQuoteReserve: TIKI.pricingQuoteReserve,
      tokenReserve: TIKI.tokenReserve,
      feeBps: TIKI.feeBps,
      creatorTaxBps: TIKI.creatorTaxBps,
    });

    const gross = getAmountOut(tokensIn, TIKI.tokenReserve, TIKI.pricingQuoteReserve);
    expect(result.grossQuoteOut).toBe(gross);
    expect(result.feeAmount).toBe((gross * TIKI.feeBps) / 10_000n);
    expect(result.creatorTaxAmount).toBe((gross * TIKI.creatorTaxBps) / 10_000n);
    expect(result.quoteOut).toBe(gross - result.feeAmount - result.creatorTaxAmount);
  });

  it("is asymmetric with buy: buy taxes input, sell taxes output", () => {
    const amount = 1_000_000_000_000_000n;
    const buy = computeCurveBuy({
      quoteIn: amount,
      pricingQuoteReserve: TIKI.pricingQuoteReserve,
      tokenReserve: TIKI.tokenReserve,
      feeBps: TIKI.feeBps,
      creatorTaxBps: 0n,
      reservedTokens: 0n,
    });
    // Buy: fee is a share of what went in.
    expect(buy.feeAmount).toBe((amount * TIKI.feeBps) / 10_000n);

    const sell = computeCurveSell({
      tokensIn: 1_000_000_000_000_000_000n,
      pricingQuoteReserve: TIKI.pricingQuoteReserve,
      tokenReserve: TIKI.tokenReserve,
      feeBps: TIKI.feeBps,
      creatorTaxBps: 0n,
    });
    // Sell: fee is a share of what came out, before deduction.
    expect(sell.feeAmount).toBe((sell.grossQuoteOut * TIKI.feeBps) / 10_000n);
  });
});

describe("price impact", () => {
  it("grows with trade size", () => {
    const small = computePriceImpactBps(
      1_000_000_000_000_000n,
      TIKI.pricingQuoteReserve,
      TIKI.tokenReserve,
    );
    const large = computePriceImpactBps(
      1_000_000_000_000_000_000n,
      TIKI.pricingQuoteReserve,
      TIKI.tokenReserve,
    );
    expect(large).toBeGreaterThan(small);
  });

  it("is zero for a zero-sized trade rather than throwing", () => {
    expect(computePriceImpactBps(0n, TIKI.pricingQuoteReserve, TIKI.tokenReserve)).toBe(
      0n,
    );
  });
});
