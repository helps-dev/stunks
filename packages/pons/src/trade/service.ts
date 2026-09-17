import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { applySlippageFloor, formatBps } from "@stunks/utils";
import {
  GraduationPhase,
  type CurveState,
  type Quote,
  type TradeSide,
} from "@stunks/types";
import { ponsV2CurveAbi } from "../abi/curve.js";
import { erc20Abi } from "../abi/index.js";
import { quoteBuy, quoteSell } from "../curve/quote.js";
import { readCurveState, readLaunchedToken, isNativeQuote } from "../client/reads.js";
import { resolvePonsAddresses } from "../client/addresses.js";
import {
  describeNoVenue,
  orderPoolCurrencies,
  resolveTradingVenue,
} from "../graduation/venue.js";

/**
 * Trade preparation.
 *
 * The ordering of checks here is the whole point, and it follows the flow the PRD
 * specifies: read state, resolve venue, quote, apply slippage, then build. Each step can
 * refuse, and a refusal is returned rather than papered over — a quote that cannot be
 * produced honestly must not be replaced with a number.
 *
 * Three specifics that a naive implementation gets wrong:
 *
 * 1. VENUE FIRST. Phase comes from a live `getLaunchedToken` read, not the database.
 *    `Swept` is a reachable state with no tradeable venue, and offering a trade there
 *    produces a guaranteed revert.
 *
 * 2. THE ON-CHAIN BOUND IS THE PROTECTION. `minTokensOut` / `minQuoteOut` are always
 *    sent. A displayed quote is advisory; only the bound is enforced.
 *
 * 3. ERC-20 QUOTE ASSETS NEED AN APPROVAL, and native ones must send no approval and an
 *    exact `msg.value`. Getting this backwards reverts.
 */

export interface PreparedTrade {
  readonly side: TradeSide;
  readonly to: Address;
  readonly data: Hex;
  /** Exact value to attach. Zero for a sell, and for ERC-20-quoted buys. */
  readonly value: bigint;
  readonly quote: Quote;
  /** Set when the caller must approve before this can be sent. */
  readonly approval: {
    readonly token: Address;
    readonly spender: Address;
    readonly amount: bigint;
    readonly data: Hex;
  } | null;
  readonly warnings: readonly string[];
}

export type PrepareTradeResult =
  | { readonly ok: true; readonly trade: PreparedTrade }
  | { readonly ok: false; readonly code: TradeRefusal; readonly message: string };

export type TradeRefusal =
  | "NOT_A_PONS_LAUNCH"
  | "NO_VENUE"
  | "UNSUPPORTED_VENUE"
  | "QUOTE_FAILED"
  | "ZERO_AMOUNT"
  | "SLIPPAGE_OUT_OF_RANGE"
  | "INSUFFICIENT_BALANCE"
  | "RPC_UNAVAILABLE";

export interface PrepareTradeArgs {
  readonly client: PublicClient;
  readonly factory: Address;
  readonly token: Address;
  readonly side: TradeSide;
  /** Quote-asset amount for a buy; token amount for a sell. */
  readonly amountIn: bigint;
  readonly slippageBps: number;
  /** Who signs and pays. */
  readonly account: Address;
  /** Who receives. Defaults to the account. */
  readonly recipient?: Address;
}

/** Slippage bounds the UI also enforces, restated here because this is the last gate. */
const MIN_SLIPPAGE_BPS = 10; // 0.1%
const MAX_SLIPPAGE_BPS = 5_000; // 50%
/** Above this, a user is very likely about to be sandwiched. */
const HIGH_SLIPPAGE_BPS = 1_000; // 10%
/** Above this price impact, say so loudly. */
const HIGH_IMPACT_BPS = 500n; // 5%

export async function prepareTrade(args: PrepareTradeArgs): Promise<PrepareTradeResult> {
  const { client, factory, token, side, amountIn, slippageBps, account } = args;
  const recipient = args.recipient ?? account;

  if (amountIn <= 0n) {
    return {
      ok: false,
      code: "ZERO_AMOUNT",
      message: "Enter an amount greater than zero.",
    };
  }
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < MIN_SLIPPAGE_BPS ||
    slippageBps > MAX_SLIPPAGE_BPS
  ) {
    return {
      ok: false,
      code: "SLIPPAGE_OUT_OF_RANGE",
      message: `Slippage must be between ${MIN_SLIPPAGE_BPS / 100}% and ${MAX_SLIPPAGE_BPS / 100}%.`,
    };
  }

  // ── 1. live state, and the venue it implies ──
  let launch;
  let state: CurveState;
  try {
    launch = await readLaunchedToken(client, factory, token);
    if (!launch.exists) {
      return {
        ok: false,
        code: "NOT_A_PONS_LAUNCH",
        message:
          "This address is not registered with the Pons V2 factory, so STUNKS will not trade it.",
      };
    }
    state = await readCurveState(client, launch.curve);
  } catch (error) {
    return {
      ok: false,
      code: "RPC_UNAVAILABLE",
      message: `Could not read the token's current state, so no trade was prepared: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // The resolver is the authority on venue, so it is given real inputs rather than
  // placeholders. Addresses are only resolved for a graduated launch: the curve path is
  // the hot one and would otherwise pay for ten reads it never uses.
  //
  // Pool currencies for a Pons launch are exactly the token and its pair token, ordered
  // the way V4 orders them. Supplying them is what lets the resolver reach its
  // UNISWAP_V4 branch instead of reporting POOL_NOT_REGISTERED, which would be a
  // misleading way to describe "we chose not to route this".
  let venue;
  if (launch.phase === GraduationPhase.PoolCreated) {
    const addresses = await resolvePonsAddresses(client, factory).catch(() => null);
    if (!addresses) {
      return {
        ok: false,
        code: "RPC_UNAVAILABLE",
        message: "Could not resolve the Pons contract graph, so no venue was determined.",
      };
    }
    venue = resolveTradingVenue({
      launch,
      poolManager: addresses.poolManager,
      memeHook: addresses.memeHook,
      poolCurrencies: orderPoolCurrencies(token, launch.pairToken),
    });
  } else {
    venue = resolveTradingVenue({
      launch,
      poolManager: launch.curve,
      memeHook: launch.curve,
    });
  }

  if (venue.kind === "NONE") {
    // `describeNoVenue` already explains every reason accurately, including that Swept
    // is recoverable by anyone. Restating it here would let the two drift apart.
    return {
      ok: false,
      code: venue.reason === "NOT_A_PONS_LAUNCH" ? "NOT_A_PONS_LAUNCH" : "NO_VENUE",
      message: describeNoVenue(venue.reason),
    };
  }

  if (venue.kind === "UNISWAP_V4") {
    // Refused rather than approximated. The V4 quoting path on this chain is not
    // verified, and the meme hook takes a cut in beforeSwap/afterSwap, so a
    // constant-product estimate would misprice the trade. A wrong number here is worse
    // than no number.
    return {
      ok: false,
      code: "UNSUPPORTED_VENUE",
      message:
        "This token has graduated to a Uniswap V4 pool. STUNKS does not route V4 swaps yet — " +
        "the quoting path is unverified, and guessing it would misprice your trade. " +
        "You can trade it on a Uniswap V4 interface.",
    };
  }

  // ── 2. quote ──
  const block = await client.getBlock().catch(() => null);
  const nowSeconds = block ? block.timestamp : BigInt(Math.floor(Date.now() / 1000));

  const quoted =
    side === "BUY"
      ? await quoteBuy({
          client,
          state,
          quoteIn: amountIn,
          slippageBps,
          recipient,
          nowSeconds,
          payer: account,
        })
      : await quoteSell({ client, state, tokensIn: amountIn, slippageBps, recipient });

  if (!quoted.ok) {
    return { ok: false, code: "QUOTE_FAILED", message: quoted.error.message };
  }
  const quote = quoted.quote;

  // ── 3. build, with the on-chain bound that actually protects the user ──
  const minOut = applySlippageFloor(quote.amountOut, slippageBps);
  const native = isNativeQuote(state.pairToken);
  const warnings: string[] = [];

  if (quote.priceImpactBps > HIGH_IMPACT_BPS) {
    warnings.push(
      `Price impact is about ${formatBps(quote.priceImpactBps)}. Your trade is large ` +
        `relative to this curve's liquidity.`,
    );
  }
  if (slippageBps > HIGH_SLIPPAGE_BPS) {
    warnings.push(
      `Slippage tolerance of ${formatBps(slippageBps)} is high. You could receive noticeably ` +
        `less than quoted.`,
    );
  }
  if (quote.snipeTaxBps > 0n) {
    warnings.push(
      `This launch is still inside its anti-snipe window and an extra ` +
        `${formatBps(quote.snipeTaxBps)} tax applies to this recipient. Waiting a few ` +
        `seconds costs far less.`,
    );
  }
  if (quote.partialFill) {
    warnings.push(
      "This buy would exhaust the curve's remaining allocation, so it will be filled only " +
        "in part and the difference refunded. You will receive up to the quoted amount.",
    );
  }

  if (side === "BUY") {
    const data = encodeFunctionData({
      abi: ponsV2CurveAbi,
      functionName: "buy",
      args: [amountIn, minOut, recipient],
    });

    // Native launches require quoteIn === msg.value exactly. ERC-20 launches must send
    // no value and rely on an approval instead.
    return {
      ok: true,
      trade: {
        side,
        to: launch.curve,
        data,
        value: native ? amountIn : 0n,
        quote,
        approval: native
          ? null
          : {
              token: state.pairToken,
              spender: launch.curve,
              amount: amountIn,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [launch.curve, amountIn],
              }),
            },
        warnings,
      },
    };
  }

  // A sell always needs the launch token approved to its own curve first.
  return {
    ok: true,
    trade: {
      side,
      to: launch.curve,
      data: encodeFunctionData({
        abi: ponsV2CurveAbi,
        functionName: "sell",
        args: [amountIn, minOut, recipient],
      }),
      value: 0n,
      quote,
      approval: {
        token,
        spender: launch.curve,
        amount: amountIn,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [launch.curve, amountIn],
        }),
      },
      warnings,
    },
  };
}

/** Whether an approval is still needed, so the UI can skip a redundant transaction. */
export async function needsApproval(args: {
  client: PublicClient;
  token: Address;
  owner: Address;
  spender: Address;
  amount: bigint;
}): Promise<boolean> {
  const allowance = (await args.client.readContract({
    address: args.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [args.owner, args.spender],
  })) as bigint;
  return allowance < args.amount;
}

export const SLIPPAGE_PRESETS_BPS = [50, 100, 300, 500] as const;
export { MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, HIGH_SLIPPAGE_BPS };
