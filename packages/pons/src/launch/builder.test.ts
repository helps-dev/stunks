import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { NATIVE_PAIR_TOKEN } from "@stunks/config";
import { launchValue, validateLaunchInput, type BuildLaunchInput } from "./builder.js";
import { classifyTxError, isTerminal, mayHaveSpent } from "./tx-state.js";

const CREATOR = "0x7d3a7e460425f0b407174608670889377c41e9bc" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const LAUNCH_FEE = 500_000_000_000_000n; // 0.0005 ETH, live value
const MAX_CREATOR_TAX = 1_000n; // 10%, live ceiling

function input(overrides: Partial<BuildLaunchInput> = {}): BuildLaunchInput {
  return {
    name: "Probe Token",
    symbol: "PROBE",
    logo: "ipfs://QmProbe",
    creator: CREATOR,
    creatorTaxBps: 200,
    buybackEnabled: true,
    launchConfigId: 0n,
    pairToken: NATIVE_PAIR_TOKEN,
    devBuyAmount: 10_000_000_000_000_000n,
    minTokensOut: 0n,
    whitelist: [],
    ...overrides,
  };
}

describe("exact msg.value rule", () => {
  /**
   * The contract compares with `!=`, not `<`. One wei either way reverts
   * NativeValueMismatch and the gas is gone, so this cannot be approximated.
   */
  it("is launchFee + devBuy for a native launch", () => {
    expect(
      launchValue({
        launchFee: LAUNCH_FEE,
        devBuyAmount: 10_000_000_000_000_000n,
        pairToken: NATIVE_PAIR_TOKEN,
      }),
    ).toBe(10_500_000_000_000_000n);
  });

  it("is launchFee alone when there is no opening buy", () => {
    expect(
      launchValue({
        launchFee: LAUNCH_FEE,
        devBuyAmount: 0n,
        pairToken: NATIVE_PAIR_TOKEN,
      }),
    ).toBe(LAUNCH_FEE);
  });

  it("EXCLUDES the buy amount for an ERC-20 pair", () => {
    // The quote asset is pulled by transferFrom. Attaching it as value reverts
    // UnexpectedNativeValue.
    expect(
      launchValue({
        launchFee: LAUNCH_FEE,
        devBuyAmount: 3_236_000_000n, // USDG, 6 decimals
        pairToken: USDG,
      }),
    ).toBe(LAUNCH_FEE);
  });
});

describe("launch input validation", () => {
  it("accepts a well-formed launch", () => {
    expect(validateLaunchInput(input(), MAX_CREATOR_TAX)).toEqual([]);
  });

  it("requires name, symbol and image", () => {
    const errors = validateLaunchInput(
      input({ name: "  ", symbol: "", logo: "" }),
      MAX_CREATOR_TAX,
    );
    expect(errors).toHaveLength(3);
  });

  it("enforces the live creator-tax ceiling and names it", () => {
    const errors = validateLaunchInput(input({ creatorTaxBps: 1_500 }), MAX_CREATOR_TAX);
    expect(errors[0]).toMatch(/cannot exceed 1000 bps/i);
    expect(errors[0]).toMatch(/10%/);
  });

  it("accepts a tax exactly at the ceiling", () => {
    expect(validateLaunchInput(input({ creatorTaxBps: 1_000 }), MAX_CREATOR_TAX)).toEqual(
      [],
    );
  });

  it("rejects a fractional tax, since bps are integers on-chain", () => {
    expect(
      validateLaunchInput(input({ creatorTaxBps: 2.5 }), MAX_CREATOR_TAX),
    ).toHaveLength(1);
  });

  it("caps metadata so socials() stays readable on-chain", () => {
    const errors = validateLaunchInput(
      input({ name: "x".repeat(100), symbol: "y".repeat(30) }),
      MAX_CREATOR_TAX,
    );
    expect(errors).toHaveLength(2);
  });

  it("rejects a social link that is not a URL", () => {
    const errors = validateLaunchInput(
      input({ socials: { twitter: "@handle" } }),
      MAX_CREATOR_TAX,
    );
    expect(errors[0]).toMatch(/must start with http/i);
  });

  it("catches a slippage floor set without a buy amount", () => {
    const errors = validateLaunchInput(
      input({ devBuyAmount: 0n, minTokensOut: 100n }),
      MAX_CREATOR_TAX,
    );
    expect(errors[0]).toMatch(/no opening buy/i);
  });
});

describe("transaction error classification", () => {
  it("recognises a user cancellation as distinct from a failure", () => {
    const result = classifyTxError(new Error("User rejected the request"));
    expect(result.code).toBe("WALLET_REJECTED");
    expect(result.message).toMatch(/cancelled/i);
  });

  it("explains the exact-value revert by its selector", () => {
    // 0xbc760cfe would otherwise reach the user as an opaque revert.
    const result = classifyTxError(new Error("execution reverted: 0xbc760cfe"));
    expect(result.code).toBe("VALUE_MISMATCH");
    expect(result.message).toMatch(/exact amount/i);
  });

  it("explains an economics re-peg as a protection, not a bug", () => {
    const result = classifyTxError(new Error("LaunchEconomicsMismatch()"));
    expect(result.code).toBe("ECONOMICS_CHANGED");
    expect(result.message).toMatch(/rather than executing at different terms/i);
  });

  it("states the 31 limit when the exemption list is rejected", () => {
    const result = classifyTxError(new Error("ExemptionListTooLong()"));
    expect(result.code).toBe("EXEMPTION_LIST_TOO_LONG");
    expect(result.message).toMatch(/at most 31/);
  });

  it("reassures the user that nothing was spent on a slippage revert", () => {
    const result = classifyTxError(new Error("SlippageExceeded(1,2)"));
    expect(result.code).toBe("SLIPPAGE");
    expect(result.message).toMatch(/nothing was spent/i);
  });

  it("warns that a transaction may still be in flight after a network error", () => {
    const result = classifyTxError(new Error("fetch failed"));
    expect(result.code).toBe("RPC_UNAVAILABLE");
    expect(result.message).toMatch(/may or may not have been sent/i);
  });

  it("never produces a bare unhelpful message", () => {
    for (const error of [
      new Error("some unmapped internal failure"),
      "a string error",
      { weird: true },
    ]) {
      const result = classifyTxError(error);
      expect(result.message.length).toBeGreaterThan(20);
      expect(result.message.toLowerCase()).not.toBe("something went wrong");
    }
  });
});

describe("transaction phases", () => {
  it("does not treat a mined transaction as finished until it is indexed", () => {
    // Signed, mined, and visible in the app are three different things.
    expect(isTerminal("Confirmed")).toBe(false);
    expect(isTerminal("Indexed")).toBe(true);
    expect(isTerminal("Failed")).toBe(true);
    expect(isTerminal("Rejected")).toBe(true);
    expect(isTerminal("AwaitingWallet")).toBe(false);
  });

  it("knows when funds may already have moved, so a retry can be worded safely", () => {
    expect(mayHaveSpent("Pending")).toBe(true);
    expect(mayHaveSpent("Confirmed")).toBe(true);
    expect(mayHaveSpent("Rejected")).toBe(false);
    expect(mayHaveSpent("AwaitingWallet")).toBe(false);
  });
});
