import { Prisma } from "@prisma/client";

/**
 * The bigint <-> Decimal(78,0) boundary.
 *
 * Prisma maps NUMERIC to its own Decimal type, and Decimal is where precision goes
 * to die if it is used casually: `.toNumber()` on a uint256 silently produces
 * garbage. These two functions are the only sanctioned crossing, and they are
 * lossless in both directions because the column has zero fractional digits.
 *
 * Anything that reads a money column and does arithmetic on it must convert to
 * bigint first via `toBigInt`.
 */

/** bigint -> Decimal for writing. Exact: base units have no fractional part. */
export function toDecimal(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString(10));
}

/**
 * Decimal -> bigint for reading.
 *
 * Rejects a fractional value rather than truncating it. A fraction in a money
 * column means a migration or a write path is wrong, and silently flooring it
 * would hide that.
 */
export function toBigInt(value: Prisma.Decimal): bigint {
  const asString = value.toFixed();
  if (!/^-?\d+$/.test(asString)) {
    throw new Error(
      `Money column held a non-integer value (${asString}). Money columns are ` +
        `Decimal(78, 0) base units and must never carry a fraction.`,
    );
  }
  return BigInt(asString);
}

/** Convenience for nullable money columns. */
export function toBigIntOrNull(value: Prisma.Decimal | null): bigint | null {
  return value === null ? null : toBigInt(value);
}

export function toDecimalOrNull(value: bigint | null): Prisma.Decimal | null {
  return value === null ? null : toDecimal(value);
}
