import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { toBigInt, toBigIntOrNull, toDecimal, toDecimalOrNull } from "./amount.js";

/**
 * The bigint <-> Decimal(78,0) boundary.
 *
 * This is where precision dies in most Web3 codebases: a uint256 read from the
 * database gets `.toNumber()`d and silently becomes garbage. These tests pin the
 * crossing as lossless in both directions, at full uint256 scale.
 */

describe("bigint to Decimal", () => {
  it("round-trips a full uint256 maximum without loss", () => {
    const max = 2n ** 256n - 1n;
    expect(toBigInt(toDecimal(max))).toBe(max);
  });

  it("round-trips a realistic 1e27 token supply", () => {
    // The live Pons config 0 supply.
    const supply = 1_000_000_000_000_000_000_000_000_000n;
    expect(toBigInt(toDecimal(supply))).toBe(supply);
  });

  it("round-trips the verified quote vector exactly", () => {
    // From the Phase 0 audit: a 1 ETH buy on the reference curve.
    const tokensOut = 366_037_735_849_056_603_773_584_905n;
    expect(toBigInt(toDecimal(tokensOut))).toBe(tokensOut);
  });

  it("round-trips zero", () => {
    expect(toBigInt(toDecimal(0n))).toBe(0n);
  });

  it("preserves a value that would lose precision as a JS number", () => {
    // Beyond Number.MAX_SAFE_INTEGER: the exact digits must survive.
    const value = 9_007_199_254_740_993n; // 2^53 + 1
    const decimal = toDecimal(value);
    expect(decimal.toFixed()).toBe("9007199254740993");
    expect(toBigInt(decimal)).toBe(value);
  });
});

describe("Decimal to bigint", () => {
  it("rejects a fractional value instead of truncating it", () => {
    // A fraction in a money column means a migration or a write path is wrong.
    // Silently flooring it would hide that.
    const fractional = new Prisma.Decimal("1.5");
    expect(() => toBigInt(fractional)).toThrow(/non-integer/i);
  });

  it("names the offending value in the error", () => {
    expect(() => toBigInt(new Prisma.Decimal("0.000001"))).toThrow(/0\.000001/);
  });

  it("accepts a negative integer, which reserves deltas legitimately produce", () => {
    expect(toBigInt(new Prisma.Decimal("-42"))).toBe(-42n);
  });
});

describe("nullable columns", () => {
  it("passes null through in both directions", () => {
    expect(toBigIntOrNull(null)).toBeNull();
    expect(toDecimalOrNull(null)).toBeNull();
  });

  it("converts a present value normally", () => {
    const value = 4_200_000_000_000_000_000n;
    const decimal = toDecimalOrNull(value);
    expect(decimal).not.toBeNull();
    expect(toBigIntOrNull(decimal)).toBe(value);
  });
});
