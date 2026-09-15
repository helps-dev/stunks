/**
 * Integer money helpers.
 *
 * Every function here mirrors Solidity semantics exactly, because the Phase 0
 * audit proved that off-chain replication of the Pons curve math matches on-chain
 * results to the wei — and that property survives only if the rounding matches
 * too. Solidity integer division truncates toward zero; for the non-negative
 * values used here that is floor.
 *
 * There is no float anywhere in this file, and there must never be.
 */

export const BASIS_POINTS = 10_000n;

/** Thrown when an argument would produce meaningless money arithmetic. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * `amount * bps / 10000`, truncated — the exact form the Pons contracts use for
 * fees and taxes, e.g. `fee = (spent * feeBps) / BASIS_POINTS`.
 */
export function applyBps(amount: bigint, bps: bigint): bigint {
  if (amount < 0n) throw new MoneyError("applyBps: amount must be non-negative");
  if (bps < 0n) throw new MoneyError("applyBps: bps must be non-negative");
  return (amount * bps) / BASIS_POINTS;
}

/** Subtract a bps share, truncating the share first (matches contract order). */
export function subtractBps(amount: bigint, bps: bigint): bigint {
  return amount - applyBps(amount, bps);
}

/** Floor division. Explicit so intent is visible at call sites. */
export function floorDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError("floorDiv: division by zero");
  return numerator / denominator;
}

/**
 * Ceiling division, matching OpenZeppelin `Math.Rounding.Ceil`. The curve uses
 * this when grossing a clamped partial fill back up to an input amount.
 */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError("ceilDiv: division by zero");
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/** `Math.mulDiv(x, y, d)` with floor rounding. */
export function mulDiv(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) throw new MoneyError("mulDiv: division by zero");
  return (x * y) / d;
}

export function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Ratio of two amounts expressed in basis points, truncated.
 * Returns 0n when the denominator is zero rather than throwing, because progress
 * bars legitimately ask about not-yet-initialised state.
 */
export function ratioBps(part: bigint, whole: bigint): bigint {
  if (whole <= 0n) return 0n;
  return (part * BASIS_POINTS) / whole;
}

/**
 * Apply a slippage tolerance to an expected output, producing the floor that is
 * sent on-chain. Rounds down, so the on-chain bound is never tighter than the
 * user's stated tolerance.
 */
export function applySlippageFloor(expectedOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new MoneyError(`applySlippageFloor: slippageBps out of range: ${slippageBps}`);
  }
  return subtractBps(expectedOut, BigInt(slippageBps));
}

/**
 * Parse a human decimal string into base units without ever touching a float.
 * Extra precision beyond `decimals` is truncated, matching how a chain would
 * treat it, rather than rounded.
 */
export function parseUnitsExact(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new MoneyError(`parseUnitsExact: invalid decimals: ${decimals}`);
  }
  const trimmed = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === "-") {
    throw new MoneyError(`parseUnitsExact: not a decimal number: ${value}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart = "", fractionPart = ""] = unsigned.split(".");
  const whole = wholePart === "" ? "0" : wholePart;
  const fraction = fractionPart.slice(0, decimals).padEnd(decimals, "0");
  const magnitude = BigInt(whole + fraction);
  return negative ? -magnitude : magnitude;
}

/**
 * Format base units as a decimal string. Display only — never feed the result
 * back into arithmetic.
 */
export function formatUnitsExact(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new MoneyError(`formatUnitsExact: invalid decimals: ${decimals}`);
  }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const fraction = magnitude % base;
  const sign = negative ? "-" : "";
  if (decimals === 0) return `${sign}${whole.toString()}`;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fractionStr === ""
    ? `${sign}${whole.toString()}`
    : `${sign}${whole.toString()}.${fractionStr}`;
}

/**
 * Serialise a bigint for transport. The API sends decimal strings, never JSON
 * numbers, because a uint256 does not survive IEEE-754.
 */
export function serialiseAmount(value: bigint): string {
  return value.toString(10);
}

/** Inverse of `serialiseAmount`, rejecting anything that is not an integer string. */
export function deserialiseAmount(value: string): bigint {
  if (!/^-?\d+$/.test(value.trim())) {
    throw new MoneyError(`deserialiseAmount: not an integer string: ${value}`);
  }
  return BigInt(value.trim());
}
