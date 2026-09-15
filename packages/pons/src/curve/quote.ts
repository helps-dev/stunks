import type { Address, PublicClient } from "viem";
import { ZERO_ADDRESS } from "@stunks/config";
import { applyBps, applySlippageFloor } from "@stunks/utils";
import type { CurveState, Quote, QuoteResult, TradeSide } from "@stunks/types";
import { ponsV2CurveAbi } from "../abi/curve.js";
import {
  SnipeTaxNotModellableError,
  computeCurveBuy,
  computeCurveSell,
  computePriceImpactBps,
} from "./math.js";
import { requiresSimulation } from "./snipe-tax.js";
import {
  readCurrentSnipeTaxBps,
  readSnipeTaxExempt,
  isNativeQuote,
} from "../client/reads.js";

/**
 * Curve quoting.
 *
 * Pons V2 has NO on-chain quote function — `quoteBuy` and `quoteSell` were both
 * confirmed absent from deployed bytecode. So there are exactly two ways to get a
 * number, and this module implements both and is explicit about which one produced
 * the answer:
 *
 *  1. LOCAL_MATH — exact bigint replication, verified to the wei against mainnet.
 *     Fast enough for keystroke-latency quoting.
 *  2. SIMULATION — eth_call against the real contract. Authoritative.
 *
 * Simulation is mandatory, not optional, when the recipient is inside the
 * anti-snipe window, because the decay is corroborated but not read from verified
 * source and being wrong there means misreporting by up to ~100x.
 *
 * A failed quote is returned as an error. It is never replaced with a dummy value.
 */

export interface QuoteBuyArgs {
  readonly client: PublicClient;
  readonly state: CurveState;
  readonly quoteIn: bigint;
  readonly slippageBps: number;
  readonly recipient: Address;
  /** Chain timestamp to evaluate the snipe window against. */
  readonly nowSeconds: bigint;
  /** Who pays. Only used for simulation; it does not affect the tax. */
  readonly payer?: Address;
}

export async function quoteBuy(args: QuoteBuyArgs): Promise<QuoteResult> {
  const { client, state, quoteIn, slippageBps, recipient, nowSeconds } = args;

  if (quoteIn <= 0n) {
    return err("ZERO_AMOUNT", "Enter an amount greater than zero.");
  }
  if (state.graduated || state.readyToGraduate) {
    return err(
      "CURVE_GRADUATED",
      "This curve has finished. Trading has moved to its Uniswap V4 pool.",
    );
  }

  let recipientExempt: boolean;
  let snipeTaxBps: bigint;
  try {
    // Read both from the chain rather than deriving them. The exemption is keyed on
    // the RECIPIENT, and currentSnipeTaxBps takes the recipient for the same reason.
    [recipientExempt, snipeTaxBps] = await Promise.all([
      readSnipeTaxExempt(client, state.curve, recipient),
      readCurrentSnipeTaxBps(client, state.curve, recipient),
    ]);
  } catch (error) {
    return err("RPC_UNAVAILABLE", describeError(error));
  }

  const mustSimulate = requiresSimulation({
    launchedAt: state.launchedAt,
    windowSeconds: state.snipeTaxSeconds,
    nowSeconds,
    recipientExempt,
  });

  // Local math is attempted, but it is allowed to decline. Inside the first second
  // of a launch the combined deductions exceed 100% and Pons's reconciliation of
  // that is measured but unexplained, so the model refuses rather than guesses.
  let local: ReturnType<typeof computeCurveBuy> | null = null;
  if (!mustSimulate) {
    try {
      local = computeCurveBuy({
        quoteIn,
        pricingQuoteReserve: state.pricingQuoteReserve,
        tokenReserve: state.tokenReserve,
        feeBps: state.feeBps,
        creatorTaxBps: state.creatorTaxBps,
        snipeTaxBps,
        reservedTokens: state.reservedTokens,
      });
    } catch (error) {
      if (!(error instanceof SnipeTaxNotModellableError)) {
        return err("INSUFFICIENT_LIQUIDITY", describeError(error));
      }
      local = null;
    }
  }

  // Local math is only trusted when it produced a result AND the fill was not
  // clamped — a clamp changes what minTokensOut even means, so those go to
  // simulation too.
  let amountOut: bigint;
  let source: Quote["source"];
  if (local !== null && !local.partialFill) {
    amountOut = local.tokensOut;
    source = "LOCAL_MATH";
  } else {
    const simulated = await simulateBuy({
      client,
      curve: state.curve,
      pairToken: state.pairToken,
      quoteIn,
      recipient,
      payer: args.payer ?? recipient,
    });
    if (!simulated.ok) return { ok: false, error: simulated.error };
    amountOut = simulated.amountOut;
    source = "SIMULATION";
  }

  // Fee components. When the model declined these are the individually-charged
  // amounts read from chain bps; their exact reconciliation above 100% is the part
  // that is unverified, so they are reported as charged rather than as a net.
  const feeAmount = local ? local.feeAmount : applyBps(quoteIn, state.feeBps);
  const creatorTaxAmount = local
    ? local.creatorTaxAmount
    : applyBps(quoteIn, state.creatorTaxBps);
  const snipeTaxAmount = local ? local.snipeTaxAmount : applyBps(quoteIn, snipeTaxBps);

  const netIn = local
    ? local.spent - local.feeAmount - local.creatorTaxAmount - local.snipeTaxAmount
    : 0n;
  const priceImpactBps =
    netIn > 0n
      ? computePriceImpactBps(netIn, state.pricingQuoteReserve, state.tokenReserve)
      : 0n;

  return {
    ok: true,
    quote: {
      side: "BUY",
      source,
      amountIn: quoteIn,
      amountOut,
      minAmountOut: applySlippageFloor(amountOut, slippageBps),
      feeAmount,
      creatorTaxAmount,
      snipeTaxAmount,
      snipeTaxBps,
      recipientExempt,
      priceImpactBps,
      partialFill: local?.partialFill ?? false,
    },
  };
}

export interface QuoteSellArgs {
  readonly client: PublicClient;
  readonly state: CurveState;
  readonly tokensIn: bigint;
  readonly slippageBps: number;
  readonly recipient: Address;
  readonly seller?: Address;
}

export async function quoteSell(args: QuoteSellArgs): Promise<QuoteResult> {
  const { state, tokensIn, slippageBps } = args;

  if (tokensIn <= 0n) {
    return err("ZERO_AMOUNT", "Enter an amount greater than zero.");
  }
  // `sell` is closed once the sellable allocation is exhausted, not merely once the
  // graduated flag is set, so both conditions are checked.
  if (state.graduated || state.readyToGraduate) {
    return err(
      "CURVE_GRADUATED",
      "This curve has finished. Selling has moved to its Uniswap V4 pool.",
    );
  }

  let local;
  try {
    local = computeCurveSell({
      tokensIn,
      pricingQuoteReserve: state.pricingQuoteReserve,
      tokenReserve: state.tokenReserve,
      feeBps: state.feeBps,
      creatorTaxBps: state.creatorTaxBps,
    });
  } catch (error) {
    return err("INSUFFICIENT_LIQUIDITY", describeError(error));
  }

  const priceImpactBps = computePriceImpactBps(
    tokensIn,
    state.tokenReserve,
    state.pricingQuoteReserve,
  );

  return {
    ok: true,
    quote: {
      side: "SELL",
      source: "LOCAL_MATH",
      amountIn: tokensIn,
      amountOut: local.quoteOut,
      minAmountOut: applySlippageFloor(local.quoteOut, slippageBps),
      feeAmount: local.feeAmount,
      creatorTaxAmount: local.creatorTaxAmount,
      // The anti-snipe tax applies to buys; a sell has no recipient-side tax.
      snipeTaxAmount: 0n,
      snipeTaxBps: 0n,
      recipientExempt: false,
      priceImpactBps,
      partialFill: false,
    },
  };
}

type QuoteFailure = Extract<QuoteResult, { ok: false }>["error"];

type SimulateBuyResult =
  | { readonly ok: true; readonly amountOut: bigint }
  | { readonly ok: false; readonly error: QuoteFailure };

/**
 * Authoritative quote via eth_call. Uses the real contract, so it accounts for the
 * anti-snipe decay and the clamp without this package having to model either.
 */
async function simulateBuy(args: {
  client: PublicClient;
  curve: Address;
  pairToken: Address;
  quoteIn: bigint;
  recipient: Address;
  payer: Address;
}): Promise<SimulateBuyResult> {
  const { client, curve, pairToken, quoteIn, recipient, payer } = args;
  try {
    const { result } = await client.simulateContract({
      address: curve,
      abi: ponsV2CurveAbi,
      functionName: "buy",
      args: [quoteIn, 0n, recipient],
      // Native launches require quoteIn === msg.value exactly. ERC-20 launches must
      // send no value at all.
      value: isNativeQuote(pairToken) ? quoteIn : 0n,
      account: payer === ZERO_ADDRESS ? recipient : payer,
    });
    return { ok: true, amountOut: result as bigint };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "SIMULATION_REVERTED",
        message: describeError(error),
      },
    };
  }
}

function err(code: QuoteFailure["code"], message: string): QuoteResult {
  return { ok: false, error: { code, message } };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: string }).shortMessage;
    return short ?? error.message;
  }
  return String(error);
}

export function quoteSideLabel(side: TradeSide): string {
  return side === "BUY" ? "Buy" : "Sell";
}
