import type { Address } from "viem";
import type { TradeSide } from "./pons.js";

/**
 * How a quote was produced. This is surfaced to the UI on purpose: the two paths
 * have different trust levels and the user's protection depends on which ran.
 *
 *  - LOCAL_MATH: exact bigint replication of the curve's integer arithmetic.
 *    Verified to match on-chain results to the wei. Only valid once the snipe
 *    window has closed.
 *  - SIMULATION: eth_call against the real contract. Authoritative. Required
 *    inside the snipe window, for partial fills, and before signing.
 */
export type QuoteSource = "LOCAL_MATH" | "SIMULATION";

export interface QuoteRequest {
  readonly token: Address;
  readonly side: TradeSide;
  /** Quote-asset amount in for a BUY, token amount in for a SELL. */
  readonly amountIn: bigint;
  readonly slippageBps: number;
  /**
   * Who receives the tokens. This matters more than it looks: the Pons snipe tax
   * is evaluated per RECIPIENT, not per sender, so the recipient decides whether
   * the tax applies at all.
   */
  readonly recipient: Address;
}

export interface Quote {
  readonly side: TradeSide;
  readonly source: QuoteSource;
  readonly amountIn: bigint;
  /** Expected output at the quoted state. */
  readonly amountOut: bigint;
  /** Slippage-adjusted floor sent on-chain as minTokensOut / minQuoteOut. */
  readonly minAmountOut: bigint;
  /** Base curve fee on the quote leg. */
  readonly feeAmount: bigint;
  /** Creator tax on the quote leg, paid entirely to the creator. */
  readonly creatorTaxAmount: bigint;
  /** Anti-snipe tax. Zero once the window closes or the recipient is exempt. */
  readonly snipeTaxAmount: bigint;
  readonly snipeTaxBps: bigint;
  /** True when the recipient is on the launch's exemption list. */
  readonly recipientExempt: boolean;
  /** Price impact in basis points, derived from reserves before and after. */
  readonly priceImpactBps: bigint;
  /**
   * Set when a BUY would cross reservedTokens and be clamped. In that case the
   * contract reinterprets minTokensOut as a PRICE bound, not a quantity bound,
   * and refunds the surplus — so the UI must say "up to".
   */
  readonly partialFill: boolean;
}

/** A quote can legitimately fail. Never substitute a dummy number. */
export type QuoteResult =
  | { readonly ok: true; readonly quote: Quote }
  | { readonly ok: false; readonly error: QuoteError };

export interface QuoteError {
  readonly code:
    | "NO_VENUE"
    | "CURVE_GRADUATED"
    | "NOT_A_PONS_LAUNCH"
    | "ZERO_AMOUNT"
    | "INSUFFICIENT_LIQUIDITY"
    | "SIMULATION_REVERTED"
    | "RPC_UNAVAILABLE"
    | "UNSUPPORTED_VENUE";
  readonly message: string;
}
