import { BASIS_POINTS, applyBps, bigintMin, ceilDiv, mulDiv } from "@stunks/utils";

/**
 * Exact replication of PonsV2BondingCurveMath and the curve's own fee handling.
 *
 * VERIFIED: these functions reproduced on-chain `eth_call` results EXACTLY, to the
 * wei, on live curve 0xe0d8C6a8c6F4aEA8e86A613FFB5545cC9372d87A at three trade
 * sizes:
 *
 *   0.01 ETH ->   5740664023199384506125347
 *   0.1  ETH ->  54586381541924592009003939
 *   1    ETH -> 366037735849056603773584905
 *
 * Every division below is floor, matching Solidity truncation. A single float
 * conversion anywhere in this path destroys the exactness, which is why
 * @stunks/utils exists and why the lint rule bans Number()/parseFloat().
 */

/**
 * Raised when the combined deductions exceed 100%, which happens inside the first
 * second of a launch for a non-exempt recipient. The contract's behaviour in that
 * regime is measured but not explained, so local math declines rather than guesses.
 * The quote path answers these by `eth_call` simulation.
 */
export class SnipeTaxNotModellableError extends Error {
  readonly feeBps: bigint;
  readonly creatorTaxBps: bigint;
  readonly snipeTaxBps: bigint;

  constructor(feeBps: bigint, creatorTaxBps: bigint, snipeTaxBps: bigint) {
    super(
      `Combined deductions exceed 100% (fee ${feeBps} + creatorTax ${creatorTaxBps} + ` +
        `snipeTax ${snipeTaxBps} bps). Pons's behaviour in this regime is not verified, ` +
        `so this quote must come from eth_call simulation, not local math.`,
    );
    this.name = "SnipeTaxNotModellableError";
    this.feeBps = feeBps;
    this.creatorTaxBps = creatorTaxBps;
    this.snipeTaxBps = snipeTaxBps;
  }
}

/** Curve constant-product output. Called by the contract with feeBps = 0. */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps = 0n,
): bigint {
  if (amountIn <= 0n) throw new Error("getAmountOut: amountIn must be positive");
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new Error("getAmountOut: insufficient liquidity");
  }
  const amountInWithFee = amountIn * (BASIS_POINTS - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BASIS_POINTS + amountInWithFee;
  return numerator / denominator;
}

/** Non-reverting variant, mirroring the library's `quoteAmountOut`. */
export function quoteAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps = 0n,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n || feeBps >= BASIS_POINTS) {
    return 0n;
  }
  const amountInWithFee = amountIn * (BASIS_POINTS - feeBps);
  return (amountInWithFee * reserveOut) / (reserveIn * BASIS_POINTS + amountInWithFee);
}

/** Input required for an exact output. Note the `+ 1n`, as in the library. */
export function getAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps = 0n,
): bigint {
  if (amountOut <= 0n) throw new Error("getAmountIn: amountOut must be positive");
  if (reserveIn <= 0n || reserveOut <= amountOut) {
    throw new Error("getAmountIn: insufficient liquidity");
  }
  if (feeBps >= BASIS_POINTS) throw new Error("getAmountIn: fee consumes entire trade");
  const numerator = amountOut * reserveIn * BASIS_POINTS;
  const denominator = (reserveOut - amountOut) * (BASIS_POINTS - feeBps);
  return numerator / denominator + 1n;
}

export interface CurveBuyMathInput {
  readonly quoteIn: bigint;
  readonly pricingQuoteReserve: bigint;
  readonly tokenReserve: bigint;
  readonly feeBps: bigint;
  readonly creatorTaxBps: bigint;
  /**
   * Anti-snipe tax for THIS RECIPIENT. Prefer the value returned by
   * `currentSnipeTaxBps(recipient)` on the curve over recomputing the decay.
   */
  readonly snipeTaxBps?: bigint;
  /** Tokens the curve refuses to sell below — the graduated pool's allocation. */
  readonly reservedTokens?: bigint;
}

export interface CurveBuyMathResult {
  readonly tokensOut: bigint;
  /** What the curve actually charges. Below `quoteIn` when the fill is clamped. */
  readonly spent: bigint;
  readonly refund: bigint;
  readonly feeAmount: bigint;
  readonly creatorTaxAmount: bigint;
  readonly snipeTaxAmount: bigint;
  readonly partialFill: boolean;
}

/**
 * Full buy simulation, including the clamp behaviour.
 *
 * A buy that would cross `reservedTokens` is NOT rejected. It is filled up to that
 * allocation, charged only for what it received, and refunded the difference — and
 * in that case the contract reinterprets `minTokensOut` as a bound on PRICE rather
 * than on quantity. That is why `partialFill` is surfaced: it changes what the UI
 * is allowed to promise.
 */
export function computeCurveBuy(input: CurveBuyMathInput): CurveBuyMathResult {
  const {
    quoteIn,
    pricingQuoteReserve,
    tokenReserve,
    feeBps,
    creatorTaxBps,
    snipeTaxBps = 0n,
    reservedTokens = 0n,
  } = input;

  if (quoteIn <= 0n) throw new Error("computeCurveBuy: quoteIn must be positive");

  const totalTaxBps = feeBps + creatorTaxBps + snipeTaxBps;
  if (totalTaxBps >= BASIS_POINTS) {
    // Not a defensive guard — a documented gap in what we can model.
    //
    // Deductions are additive while the total stays under 100%: measured on-chain
    // at age 1 s, feeBps 100 + creatorTaxBps 200 + snipeTaxBps 618 produced exactly
    // 918 bps of deduction.
    //
    // But at age 0 s the same curve with snipeTaxBps 9900 deducted exactly 9900 bps,
    // not the additive 10200. How the contract reconciles an over-100% total is NOT
    // verified, so replicating it would be a guess about someone's money.
    //
    // Callers must simulate instead. `requiresSimulation()` already routes every
    // in-window non-exempt quote down that path.
    throw new SnipeTaxNotModellableError(feeBps, creatorTaxBps, snipeTaxBps);
  }

  let spent = quoteIn;
  let feeAmount = applyBps(spent, feeBps);
  let creatorTaxAmount = applyBps(spent, creatorTaxBps);
  let snipeTaxAmount = applyBps(spent, snipeTaxBps);

  let tokensOut = getAmountOut(
    spent - feeAmount - creatorTaxAmount - snipeTaxAmount,
    pricingQuoteReserve,
    tokenReserve,
  );

  const sellable = tokenReserve > reservedTokens ? tokenReserve - reservedTokens : 0n;
  if (sellable === 0n) {
    throw new Error("computeCurveBuy: curve has no sellable allocation left");
  }

  let partialFill = false;
  if (tokensOut > sellable) {
    partialFill = true;
    tokensOut = sellable;
    // Price the clamped fill from the token side, then gross back up so the fee
    // legs still come out of the input — exactly as the contract does.
    const net = getAmountIn(sellable, pricingQuoteReserve, tokenReserve);
    spent = bigintMin(ceilDiv(net * BASIS_POINTS, BASIS_POINTS - totalTaxBps), quoteIn);
    feeAmount = applyBps(spent, feeBps);
    creatorTaxAmount = applyBps(spent, creatorTaxBps);
    snipeTaxAmount = applyBps(spent, snipeTaxBps);
  }

  return {
    tokensOut,
    spent,
    refund: quoteIn - spent,
    feeAmount,
    creatorTaxAmount,
    snipeTaxAmount,
    partialFill,
  };
}

export interface CurveSellMathInput {
  readonly tokensIn: bigint;
  readonly pricingQuoteReserve: bigint;
  readonly tokenReserve: bigint;
  readonly feeBps: bigint;
  readonly creatorTaxBps: bigint;
}

export interface CurveSellMathResult {
  readonly quoteOut: bigint;
  readonly grossQuoteOut: bigint;
  readonly feeAmount: bigint;
  readonly creatorTaxAmount: bigint;
}

/**
 * Sell simulation.
 *
 * Note the asymmetry with buy: on a sell the fee is taken from the OUTPUT after
 * pricing, whereas on a buy it comes off the INPUT before pricing. Both are
 * quote-denominated, so the curve never accrues memecoin-denominated fees.
 */
export function computeCurveSell(input: CurveSellMathInput): CurveSellMathResult {
  const { tokensIn, pricingQuoteReserve, tokenReserve, feeBps, creatorTaxBps } = input;
  if (tokensIn <= 0n) throw new Error("computeCurveSell: tokensIn must be positive");

  const grossQuoteOut = getAmountOut(tokensIn, tokenReserve, pricingQuoteReserve);
  const feeAmount = applyBps(grossQuoteOut, feeBps);
  const creatorTaxAmount = applyBps(grossQuoteOut, creatorTaxBps);

  return {
    quoteOut: grossQuoteOut - feeAmount - creatorTaxAmount,
    grossQuoteOut,
    feeAmount,
    creatorTaxAmount,
  };
}

/**
 * Tokens the curve will never sell, i.e. the graduated pool's allocation.
 *
 * VERIFIED byte-exact against the chain:
 *   supply 1e27, phantomQuote 1.68e18, threshold 4.2e18
 *   -> 285714285714285714285714285, matching reservedTokens() exactly.
 *
 * Because phantomQuote * supply is held constant, the quote-side threshold and the
 * token-side allocation describe the same point.
 */
export function computeReservedTokens(
  supply: bigint,
  phantomQuote: bigint,
  graduationThreshold: bigint,
): bigint {
  if (phantomQuote + graduationThreshold === 0n) {
    throw new Error("computeReservedTokens: degenerate launch economics");
  }
  return mulDiv(supply, phantomQuote, phantomQuote + graduationThreshold);
}

/**
 * Price impact in basis points, derived from the pricing reserve before and after.
 * Uses the spot price ratio, so it is comparable across trade sizes.
 */
export function computePriceImpactBps(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountOut = quoteAmountOut(amountIn, reserveIn, reserveOut);
  if (amountOut === 0n) return 0n;

  // spot price before = reserveIn / reserveOut
  // effective price    = amountIn / amountOut
  // impact = (effective - spot) / spot, in bps, all in integer arithmetic
  const spotNumerator = reserveIn * amountOut;
  const effectiveNumerator = amountIn * reserveOut;
  if (effectiveNumerator <= spotNumerator) return 0n;
  return ((effectiveNumerator - spotNumerator) * BASIS_POINTS) / spotNumerator;
}
