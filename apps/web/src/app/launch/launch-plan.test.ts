import { describe, expect, it } from "vitest";
import {
  decimalsChanged,
  nativePrincipalRequired,
  supportsProtectedBuySequence,
} from "./launch-plan.js";

describe("launch funding plan", () => {
  it("includes launch fee, developer buy, and every protected wallet buy", () => {
    const required = nativePrincipalRequired({
      launchFee: 500_000_000_000_000n,
      developerBuy: 10_000_000_000_000_000n,
      protectedBuyTotal: 35_000_000_000_000_000n,
    });
    expect(required).toBe(45_500_000_000_000_000n);
  });

  it("never presents ERC-20 wallet rows as a launch-window protected sequence", () => {
    expect(supportsProtectedBuySequence(true)).toBe(true);
    expect(supportsProtectedBuySequence(false)).toBe(false);
  });

  it("requires review when the live ERC-20 decimal scale changes", () => {
    expect(decimalsChanged(6, 6)).toBe(false);
    expect(decimalsChanged(6, 18)).toBe(true);
  });
});
