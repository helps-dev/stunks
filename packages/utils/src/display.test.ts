import { describe, expect, it } from "vitest";
import {
  formatBlockLag,
  formatBps,
  formatCompact,
  formatPrice,
  formatProgress,
  formatRelativeTime,
  shortAddress,
} from "./display.js";

const ETH = 1_000_000_000_000_000_000n;

describe("formatCompact", () => {
  it("abbreviates at K, M and B", () => {
    expect(formatCompact(1_500n * ETH, 18)).toBe("1.5K");
    expect(formatCompact(45_600_000n * ETH, 18)).toBe("45.6M");
    expect(formatCompact(3_400_000_000n * ETH, 18)).toBe("3.4B");
  });

  it("truncates rather than rounding up", () => {
    // Showing 1.3M for 1,250,000 would overstate a market cap. On a page where people
    // make buying decisions, erring upward is the wrong direction.
    expect(formatCompact(1_250_000n * ETH, 18)).toBe("1.25M");
    expect(formatCompact(1_999_999n * ETH, 18, 1)).toBe("1.9M");
  });

  it("handles a 1e27 supply without loss", () => {
    // The live Pons config: 1,000,000,000 tokens at 18 decimals.
    expect(formatCompact(10n ** 27n, 18)).toBe("1B");
  });

  it("handles USDG's 6 decimals", () => {
    expect(formatCompact(3_236_000_000n, 6)).toBe("3.23K");
  });

  it("trims a trailing zero fraction", () => {
    expect(formatCompact(2_000n * ETH, 18)).toBe("2K");
  });

  it("formats zero and negatives", () => {
    expect(formatCompact(0n, 18)).toBe("0");
    expect(formatCompact(-1_500n * ETH, 18)).toBe("-1.5K");
  });

  it("survives a value far beyond 2^53", () => {
    // A float would already be wrong here.
    const huge = 10n ** 40n;
    expect(formatCompact(huge, 18)).toContain("B");
  });
});

describe("formatPrice", () => {
  // The indexer stores prices at 1e27. These vectors are the same real prices as
  // before, restated at that scale.
  const SCALE = 10n ** 27n;

  it("keeps significant digits for a memecoin price", () => {
    // ~1.68e-9 ETH at launch. A fixed 2-decimal format would render this as "0.00".
    expect(formatPrice(1_680_000_000n * 10n ** 9n, 18)).toBe("0.00000000168");
  });

  it("renders the verified trade price", () => {
    // 1 ETH bought 366,037,735,849,056,603,773,584,905 tokens.
    expect(formatPrice(2_731_958_762n * 10n ** 9n, 18)).toBe("0.000000002731");
  });

  it("reads normally when the price is large", () => {
    expect(formatPrice(SCALE, 18)).toBe("1");
  });

  it("respects a non-18-decimal token", () => {
    expect(formatPrice(SCALE, 18, 4, 18)).toBe("1");
    expect(formatPrice(SCALE, 18, 4, 6)).not.toBe("1");
  });

  it("returns zero for a token that has never traded", () => {
    expect(formatPrice(0n, 18)).toBe("0");
  });

  it("respects a non-18-decimal quote asset", () => {
    // The same scaled price against USDG's 6 decimals is 1e12 times larger.
    const usdg = formatPrice(1_680_000_000n * 10n ** 9n, 6);
    const eth = formatPrice(1_680_000_000n * 10n ** 9n, 18);
    expect(usdg).not.toBe(eth);
  });

  it("reads a price the old 1e18 scale could not represent at all", () => {
    // SATOSHI, quoted in the 8-decimal asset: 2,823 quote base units bought
    // 540,440,857,263,784,622,848,790 token base units.
    //
    //   2823 * 1e18 / 5.4044e23 = 0.0052  -> floors to 0, and the UI showed "0"
    //   2823 * 1e27 / 5.4044e23 = 5223890 -> a real number
    //
    // 124 of 124 tokens quoted in that asset were stored with price 0, including this
    // one after 395 settled trades.
    const priceAt1e27 = 5_223_890n;
    expect(formatPrice(priceAt1e27, 8)).not.toBe("0");
  });

  it("is told the scale rather than assuming it", () => {
    // A value stored under the old scale, read with the old exponent, is the same
    // price as that value shifted up by 1e9 and read with the new one.
    const legacy = formatPrice(1_680_000_000n, 18, 4, 18, 18);
    const current = formatPrice(1_680_000_000n * 10n ** 9n, 18, 4, 18, 27);
    expect(current).toBe(legacy);
  });
});

describe("formatBps", () => {
  it("formats the live fee and tax values", () => {
    expect(formatBps(100n)).toBe("1%");
    expect(formatBps(200n)).toBe("2%");
    expect(formatBps(3_000n)).toBe("30%");
    expect(formatBps(9_900n)).toBe("99%");
  });

  it("keeps fractional bps visible", () => {
    // The snipe tax at 1s is 618 bps — displaying "6%" would hide the .18.
    expect(formatBps(618n)).toBe("6.18%");
    expect(formatBps(19n)).toBe("0.19%");
  });

  it("accepts a number as well as a bigint", () => {
    expect(formatBps(1_000)).toBe("10%");
  });
});

describe("formatProgress", () => {
  it("floors to a whole percent", () => {
    expect(formatProgress(9_761)).toBe("97%");
    expect(formatProgress(0)).toBe("0%");
  });

  it("clamps out-of-range input", () => {
    expect(formatProgress(12_000)).toBe("100%");
    expect(formatProgress(-5)).toBe("0%");
  });
});

describe("shortAddress", () => {
  it("shortens with an ellipsis", () => {
    expect(shortAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e")).toBe(
      "0x7eD5…EC7e",
    );
  });

  it("leaves a short string alone", () => {
    expect(shortAddress("0x1234")).toBe("0x1234");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-09-15T12:00:00Z");

  it("shows seconds, which matter on a 100ms chain", () => {
    expect(formatRelativeTime(new Date("2026-09-15T11:59:48Z"), now)).toBe("12s");
  });

  it("steps up through minutes, hours and days", () => {
    expect(formatRelativeTime(new Date("2026-09-15T11:55:00Z"), now)).toBe("5m");
    expect(formatRelativeTime(new Date("2026-09-15T09:00:00Z"), now)).toBe("3h");
    expect(formatRelativeTime(new Date("2026-09-13T12:00:00Z"), now)).toBe("2d");
  });

  it("does not show a negative age from clock skew", () => {
    expect(formatRelativeTime(new Date("2026-09-15T12:00:05Z"), now)).toBe("just now");
  });
});

describe("formatBlockLag", () => {
  const BLOCK_TIME = 0.1013;

  it("translates blocks into time, because blocks alone mislead", () => {
    // 10,000 blocks sounds alarming but is about 17 minutes here.
    expect(formatBlockLag(10_000n, BLOCK_TIME)).toBe("17m behind");
    expect(formatBlockLag(100n, BLOCK_TIME)).toBe("10s behind");
  });

  it("says so plainly when there is no lag", () => {
    expect(formatBlockLag(0n, BLOCK_TIME)).toBe("up to date");
    expect(formatBlockLag(-5n, BLOCK_TIME)).toBe("up to date");
  });

  it("uses hours for a large backlog", () => {
    expect(formatBlockLag(1_000_000n, BLOCK_TIME)).toBe("28h behind");
  });
});
