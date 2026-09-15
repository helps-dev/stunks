import { describe, expect, it } from "vitest";
import {
  BASIS_POINTS,
  MoneyError,
  applyBps,
  applySlippageFloor,
  ceilDiv,
  deserialiseAmount,
  floorDiv,
  formatUnitsExact,
  mulDiv,
  parseUnitsExact,
  ratioBps,
  serialiseAmount,
  subtractBps,
} from "./money.js";

describe("bps arithmetic matches Solidity truncation", () => {
  it("truncates rather than rounding", () => {
    // 7 * 100 / 10000 = 0.07 -> 0
    expect(applyBps(7n, 100n)).toBe(0n);
    // 12345 * 250 / 10000 = 308.625 -> 308
    expect(applyBps(12_345n, 250n)).toBe(308n);
  });

  it("reproduces the live curve's 1% fee on 1 ETH", () => {
    expect(applyBps(1_000_000_000_000_000_000n, 100n)).toBe(10_000_000_000_000_000n);
  });

  it("subtracts the truncated share, in the contract's order", () => {
    expect(subtractBps(12_345n, 250n)).toBe(12_345n - 308n);
  });

  it("rejects negative inputs instead of producing nonsense", () => {
    expect(() => applyBps(-1n, 100n)).toThrow(MoneyError);
    expect(() => applyBps(1n, -100n)).toThrow(MoneyError);
  });
});

describe("division helpers", () => {
  it("floors", () => {
    expect(floorDiv(7n, 2n)).toBe(3n);
  });

  it("ceils, matching OpenZeppelin Math.Rounding.Ceil", () => {
    expect(ceilDiv(7n, 2n)).toBe(4n);
    expect(ceilDiv(8n, 2n)).toBe(4n);
    expect(ceilDiv(0n, 2n)).toBe(0n);
  });

  it("mulDiv floors, and does not overflow at uint256 scale", () => {
    const big = 2n ** 200n;
    expect(mulDiv(big, 3n, 2n)).toBe((big * 3n) / 2n);
  });

  it("throws on division by zero rather than returning Infinity", () => {
    expect(() => floorDiv(1n, 0n)).toThrow(MoneyError);
    expect(() => ceilDiv(1n, 0n)).toThrow(MoneyError);
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(MoneyError);
  });
});

describe("ratioBps", () => {
  it("expresses a share in basis points", () => {
    expect(ratioBps(1n, 2n)).toBe(5_000n);
    expect(ratioBps(2_857n, 10_000n)).toBe(2_857n);
  });

  it("returns zero for an uninitialised denominator rather than throwing", () => {
    // Progress bars legitimately ask about state that does not exist yet.
    expect(ratioBps(5n, 0n)).toBe(0n);
  });
});

describe("slippage floors", () => {
  it("rounds the floor down, never tightening the user's tolerance", () => {
    // 1% off 12345 = 123.45 truncated to 123
    expect(applySlippageFloor(12_345n, 100)).toBe(12_345n - 123n);
  });

  it("a zero tolerance leaves the expected output untouched", () => {
    expect(applySlippageFloor(1_000n, 0)).toBe(1_000n);
  });

  it("rejects an out-of-range tolerance", () => {
    expect(() => applySlippageFloor(1_000n, -1)).toThrow(MoneyError);
    expect(() => applySlippageFloor(1_000n, 10_001)).toThrow(MoneyError);
    expect(() => applySlippageFloor(1_000n, 1.5)).toThrow(MoneyError);
  });
});

describe("parsing without floats", () => {
  it("parses 18-decimal amounts exactly", () => {
    expect(parseUnitsExact("1", 18)).toBe(1_000_000_000_000_000_000n);
    expect(parseUnitsExact("0.05", 18)).toBe(50_000_000_000_000_000n);
    expect(parseUnitsExact("1.68", 18)).toBe(1_680_000_000_000_000_000n);
  });

  it("handles USDG's 6 decimals, which is a real trap on this chain", () => {
    // The audit found USDG uses 6 decimals while every other pair uses 18.
    expect(parseUnitsExact("3236", 6)).toBe(3_236_000_000n);
    expect(parseUnitsExact("8090", 6)).toBe(8_090_000_000n);
  });

  it("survives a value that a float would mangle", () => {
    // 0.1 + 0.2 territory: this must be exact.
    expect(parseUnitsExact("0.1", 18) + parseUnitsExact("0.2", 18)).toBe(
      parseUnitsExact("0.3", 18),
    );
  });

  it("truncates excess precision instead of rounding it", () => {
    expect(parseUnitsExact("1.9999999", 2)).toBe(199n);
  });

  it("rejects non-numeric input", () => {
    expect(() => parseUnitsExact("abc", 18)).toThrow(MoneyError);
    expect(() => parseUnitsExact("", 18)).toThrow(MoneyError);
    expect(() => parseUnitsExact("1e18", 18)).toThrow(MoneyError);
  });
});

describe("formatting", () => {
  it("round-trips through parse", () => {
    for (const value of ["0", "1", "0.05", "1.68", "4.2", "1234.56789"]) {
      expect(formatUnitsExact(parseUnitsExact(value, 18), 18)).toBe(value);
    }
  });

  it("trims trailing zeros but keeps significant digits", () => {
    expect(formatUnitsExact(1_680_000_000_000_000_000n, 18)).toBe("1.68");
    expect(formatUnitsExact(1_000_000_000_000_000_000n, 18)).toBe("1");
  });

  it("formats a full uint256-scale supply without loss", () => {
    const supply = 1_000_000_000_000_000_000_000_000_000n; // 1e27
    expect(formatUnitsExact(supply, 18)).toBe("1000000000");
  });
});

describe("transport serialisation", () => {
  it("uses decimal strings so a uint256 survives JSON", () => {
    const value = 2n ** 255n;
    expect(deserialiseAmount(serialiseAmount(value))).toBe(value);
  });

  it("rejects a non-integer string", () => {
    expect(() => deserialiseAmount("1.5")).toThrow(MoneyError);
    expect(() => deserialiseAmount("abc")).toThrow(MoneyError);
  });
});

describe("BASIS_POINTS", () => {
  it("is 10000, matching the contracts", () => {
    expect(BASIS_POINTS).toBe(10_000n);
  });
});
