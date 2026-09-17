import { mulDiv } from "@stunks/utils";

/**
 * Price and market cap, derived from actual trade events.
 *
 * Two rules, both from the project's hard constraints:
 *
 * 1. Integers only. A price here feeds market cap, which feeds Explore sorting and
 *    the trending engine. One float conversion and every downstream number is
 *    subtly wrong in a way nothing will flag.
 *
 * 2. Derived from what actually settled, never from a quote. The quote leg and the
 *    token leg both come out of the emitted event, so the price is what the trader
 *    really paid — including any anti-snipe tax they suffered.
 *
 * PRICE UNIT, stated once so it is never ambiguous:
 *
 *   price = quote base units per 1e18 token base units, times PRICE_SCALE
 *
 * Scaling is what keeps a memecoin's price expressible at all. A token priced at
 * ~1.7e-9 ETH would truncate to zero in integer arithmetic without it.
 *
 * WHY THE SCALE IS 1e27 AND NOT 1e18
 *
 * 1e18 was enough only for an 18-decimal quote asset. It is not a property of the
 * token — it is a property of the QUOTE, and this chain has approved quote assets
 * with 6 and 8 decimals. Fewer decimals in the quote leg means a numerically smaller
 * `quoteAmount` against the same 1e18-scaled `tokenAmount`, and the quotient
 * truncates.
 *
 * Measured on 2026-09-17 against the indexed database:
 *
 *   quote decimals   tokens   price = 0
 *   18               21,214   78      (0.4%)
 *    6                2,022   21      (1.0%)
 *    8                  124   124     (100%)
 *
 * Every token quoted in the 8-decimal asset had a price of zero, including SATOSHI
 * with 395 settled trades. Its most recent trade moved 2,823 quote base units for
 * 540,440,857,263,784,622,848,790 token base units:
 *
 *   2823 * 1e18 / 5.4044e23 = 0.0052  ->  floors to 0
 *   2823 * 1e27 / 5.4044e23 = 5223890 ->  exact enough to sort and display
 *
 * Nothing about this is a float bug, which is why the lint rule could not see it. It
 * is integer truncation at a scale chosen for one asset and applied to all of them.
 *
 * MARKET CAP AND VOLUME ARE UNAFFECTED. `marketCapFromPrice` divides the same scale
 * back out, so market cap stays in quote base units and every existing formatting
 * call site keeps working. Only `price` itself changes scale — which does mean stored
 * price rows written under the old scale are 1e9 too small and must be recomputed.
 */

/**
 * The fixed scale price is expressed against.
 *
 * Changing this changes the meaning of every stored `price`, in both `tokens` and
 * `trades`. Rows written under a previous scale are not comparable with new ones, so
 * a change has to be followed by a recompute — see `scripts/recompute-prices.ts`.
 */
export const PRICE_SCALE = 10n ** 27n;

/** The scale used before 2026-09-17. Retained so a migration can recognise old rows. */
export const LEGACY_PRICE_SCALE = 10n ** 18n;

export interface TradeAmounts {
  /** Quote asset that actually moved, in its own base units. */
  readonly quoteAmount: bigint;
  /** Tokens that actually moved, in token base units. */
  readonly tokenAmount: bigint;
}

/**
 * Effective price of a settled trade.
 *
 * Returns 0n for a zero-token trade rather than throwing: a clamped buy near
 * graduation can legitimately settle with a refund and a tiny fill, and the indexer
 * must not crash on a real on-chain event.
 */
export function priceFromTrade(amounts: TradeAmounts): bigint {
  if (amounts.tokenAmount <= 0n) return 0n;
  if (amounts.quoteAmount <= 0n) return 0n;
  return mulDiv(amounts.quoteAmount, PRICE_SCALE, amounts.tokenAmount);
}

/**
 * Spot price from curve reserves, for a token that has not traded yet.
 *
 * Uses the PRICING reserve, which includes the phantom quote. That is deliberate and
 * is the reason a fresh launch has a non-zero price at all: the curve opens with a
 * virtual 1.68 ETH against the full supply. Using the real reserve here would report
 * a price of zero for every untraded token.
 */
export function priceFromReserves(args: {
  pricingQuoteReserve: bigint;
  tokenReserve: bigint;
}): bigint {
  if (args.tokenReserve <= 0n) return 0n;
  return mulDiv(args.pricingQuoteReserve, PRICE_SCALE, args.tokenReserve);
}

/**
 * Market cap = price x total supply.
 *
 * The PRD specifies current price times total supply, so that is what this does —
 * not circulating supply, which on a bonding curve would be ambiguous while the
 * curve still holds most of the tokens.
 *
 * The PRICE_SCALE introduced by `priceFromTrade` is divided back out here, so the
 * result is in quote base units.
 */
export function marketCapFromPrice(price: bigint, totalSupply: bigint): bigint {
  if (price <= 0n || totalSupply <= 0n) return 0n;
  return mulDiv(price, totalSupply, PRICE_SCALE);
}

/**
 * Volume contribution of a trade, always measured on the quote leg.
 *
 * Using the quote leg for both directions is what makes buy and sell volume
 * comparable and denominated in one asset. Measuring a sell in tokens and a buy in
 * ETH would produce a number that means nothing when summed.
 *
 * `quoteAmount` is what settled, so a refunded portion of a clamped buy is already
 * excluded by the event itself.
 */
export function volumeFromTrade(amounts: TradeAmounts): bigint {
  return amounts.quoteAmount > 0n ? amounts.quoteAmount : 0n;
}

/**
 * Whether a trade should count toward competition volume.
 *
 * Deliberately conservative and deliberately explicit: each exclusion returns a
 * reason, which is stored on the row so the effect of the anti-abuse rules stays
 * auditable rather than becoming an unexplained gap in someone's leaderboard total.
 */
export function competitionExclusion(args: {
  traderAddress: string;
  recipientAddress: string;
  quoteAmount: bigint;
  minTradeSize: bigint;
  excludedAddresses: readonly string[];
  /** Wallets that were on this launch's snipe-tax whitelist. */
  bundleWallets?: readonly string[];
}): { excluded: boolean; reason?: string } {
  const trader = args.traderAddress.toLowerCase();
  const recipient = args.recipientAddress.toLowerCase();

  if (args.quoteAmount < args.minTradeSize) {
    return { excluded: true, reason: "BELOW_MIN_TRADE_SIZE" };
  }

  if (args.excludedAddresses.some((address) => address.toLowerCase() === trader)) {
    return { excluded: true, reason: "ADDRESS_EXCLUDED" };
  }

  // A bundle recipient did not compete for its fill; it was handed one at the
  // untaxed price. Counting that as trading volume would let a launch farm its own
  // leaderboard.
  if (args.bundleWallets?.some((address) => address.toLowerCase() === recipient)) {
    return { excluded: true, reason: "BUNDLE_RECIPIENT" };
  }

  return { excluded: false };
}
