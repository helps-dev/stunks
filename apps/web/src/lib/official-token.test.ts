import { describe, expect, it } from "vitest";
import { describeChange } from "./official-token";

/**
 * Covers the rule the spotlight's headline number depends on: how the change window is
 * named. The query behind it needs a database and is exercised against the live one by
 * hand; this config runs without one, deliberately.
 */

describe("describeChange", () => {
  it("names the window that was actually measured", () => {
    // Aggregate history was fifteen hours wide in total when this was built, so
    // labelling every comparison "24H" would have been wrong for every token.
    expect(describeChange({ changeBps: 1440, changeWindowHours: 15 })?.label).toBe(
      "15H change",
    );
    expect(describeChange({ changeBps: 1440, changeWindowHours: 31 })?.label).toBe(
      "31H change",
    );
    expect(describeChange({ changeBps: 1440, changeWindowHours: 24 })?.label).toBe(
      "24H change",
    );
  });

  it("signs both directions explicitly", () => {
    expect(describeChange({ changeBps: 1440, changeWindowHours: 24 })?.value).toBe(
      "+14.4%",
    );
    expect(describeChange({ changeBps: -2860, changeWindowHours: 14 })?.value).toBe(
      "-28.6%",
    );
  });

  it("marks direction for colour", () => {
    expect(describeChange({ changeBps: 1, changeWindowHours: 24 })?.tone).toBe("up");
    expect(describeChange({ changeBps: -1, changeWindowHours: 24 })?.tone).toBe("down");
    // Flat reads as a gain rather than a loss; there is no third colour and a red
    // zero would suggest a fall that did not happen.
    expect(describeChange({ changeBps: 0, changeWindowHours: 24 })?.tone).toBe("up");
  });

  it("renders nothing when there is no comparable price", () => {
    // Null is not zero. Zero claims the price did not move; null says nothing is known,
    // and the tile is left out rather than showing a figure with no basis.
    expect(describeChange({ changeBps: null, changeWindowHours: null })).toBeNull();
  });

  it("falls back to the preferred window only when the width is missing", () => {
    expect(describeChange({ changeBps: 500, changeWindowHours: null })?.label).toBe(
      "24H change",
    );
  });
});
