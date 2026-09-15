import { BASIS_POINTS, formatUnitsExact } from "./money.js";

/**
 * Display formatting.
 *
 * This is the ONLY place a financial value is allowed to become lossy, and it happens
 * at render time — never before storage, and never on a value that will be used in
 * further arithmetic.
 *
 * Every function here does its rounding with integer arithmetic rather than
 * `toFixed()` on a float, because a market cap can exceed 2^53 and would already be
 * wrong by the time a float saw it.
 */

/**
 * Compact amount: 1.2K, 45.6M, 3.4B.
 *
 * Truncates rather than rounds, so a displayed figure is never larger than the real
 * one. Showing "1.3M" for 1,250,000 would overstate a market cap, and on a page where
 * people make buying decisions that is the wrong direction to err.
 */
export function formatCompact(value: bigint, decimals: number, precision = 2): string {
  if (value === 0n) return "0";

  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);

  const units: [bigint, string][] = [
    [base * 1_000_000_000n, "B"],
    [base * 1_000_000n, "M"],
    [base * 1_000n, "K"],
  ];

  for (const [threshold, suffix] of units) {
    if (magnitude >= threshold) {
      return `${negative ? "-" : ""}${quotientWithPrecision(magnitude, threshold, precision)}${suffix}`;
    }
  }

  return `${negative ? "-" : ""}${quotientWithPrecision(magnitude, base, precision)}`;
}

/**
 * Integer division rendered with a fixed number of decimal places.
 * Trailing zeros are trimmed so "1.00" reads as "1".
 */
function quotientWithPrecision(
  value: bigint,
  divisor: bigint,
  precision: number,
): string {
  const scale = 10n ** BigInt(precision);
  const scaled = (value * scale) / divisor; // floor
  const whole = scaled / scale;
  const fraction = scaled % scale;
  if (fraction === 0n) return whole.toString();
  const fractionStr = fraction.toString().padStart(precision, "0").replace(/0+$/, "");
  return fractionStr === "" ? whole.toString() : `${whole}.${fractionStr}`;
}

/**
 * A price expressed at PRICE_SCALE (quote base units per 1e18 token base units).
 *
 * The scaling is easy to get wrong, so stated explicitly:
 *
 *   priceScaled = quoteAmount * 1e18 / tokenAmount
 *
 * For an 18-decimal token, 1e18 base units IS one whole token, so `priceScaled` is
 * already "quote base units per whole token". Converting it to a human figure
 * therefore divides by the QUOTE decimals only. Dividing by `quoteDecimals + 18` — as
 * a first version of this did — scales the result down by 1e18 and renders every price
 * as a string of zeros.
 *
 * `tokenDecimals` is a parameter rather than an assumption. Every Pons launch observed
 * uses 18, but a price that silently assumes it would be wrong by orders of magnitude
 * if that ever changed.
 *
 * Memecoin prices are extremely small — around 1.7e-9 ETH at launch — so a fixed
 * number of decimal places would render them all as "0.00". This keeps significant
 * digits instead of a fixed position.
 */
export function formatPrice(
  priceScaled: bigint,
  quoteDecimals: number,
  significantDigits = 4,
  tokenDecimals = 18,
): string {
  if (priceScaled <= 0n) return "0";

  // price_per_whole_token = priceScaled * 10^tokenDecimals / 1e18, in quote base units.
  // Fold that into the divisor exponent rather than dividing twice and losing precision.
  const totalDecimals = quoteDecimals + 18 - tokenDecimals;
  const full = formatUnitsExact(priceScaled, totalDecimals);

  const [whole = "0", fraction = ""] = full.split(".");
  if (whole !== "0") {
    // Large enough to read normally.
    return fraction === "" ? whole : `${whole}.${fraction.slice(0, 2)}`;
  }

  // Keep the first significant digits after the leading zeros.
  const firstSignificant = fraction.search(/[1-9]/);
  if (firstSignificant === -1) return "0";
  return `0.${fraction.slice(0, firstSignificant + significantDigits)}`;
}

/** Basis points as a percentage string. Integer arithmetic only. */
export function formatBps(bps: bigint | number, decimals = 2): string {
  const value = typeof bps === "bigint" ? bps : BigInt(Math.round(bps));
  const whole = value / 100n;
  const fraction = value % 100n;
  if (decimals === 0 || fraction === 0n) return `${whole}%`;
  return `${whole}.${fraction.toString().padStart(2, "0").slice(0, decimals)}%`;
}

/** Progress as a whole percentage, clamped to 0..100. */
export function formatProgress(bps: number): string {
  const clamped = Math.max(0, Math.min(10_000, bps));
  return `${Math.floor(clamped / 100)}%`;
}

/** `0x1234…abcd` */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * Relative time: "12s", "5m", "3h", "2d".
 *
 * At ~101 ms per block, "just now" is a meaningful and common answer, so seconds are
 * shown rather than rounded away.
 */
export function formatRelativeTime(from: Date, now: Date = new Date()): string {
  const seconds = Math.floor((now.getTime() - from.getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Block count as a duration, using this chain's measured block time. */
export function formatBlockLag(blocks: bigint, blockTimeSeconds: number): string {
  if (blocks <= 0n) return "up to date";
  // eslint-disable-next-line no-restricted-syntax -- a block count is not money; this is a human-readable estimate
  const seconds = Math.round(Number(blocks) * blockTimeSeconds);
  if (seconds < 60) return `${seconds}s behind`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m behind`;
  return `${Math.round(seconds / 3600)}h behind`;
}

export { BASIS_POINTS };
