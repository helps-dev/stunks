import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { GraduationPhase, type LaunchedToken } from "@stunks/types";
import { describeNoVenue, orderPoolCurrencies, resolveTradingVenue } from "./venue.js";
import {
  computeGraduationProgress,
  describePhase,
  isTradeablePhase,
  parseGraduationPhase,
} from "./progress.js";

/**
 * Exhaustive venue resolution.
 *
 * `Swept` is the case that matters. It is a reachable state where the curve has been
 * drained and trading halted but the V4 pool does not exist, and a resolver that
 * only asks "graduated or not" will offer trades there that always revert.
 */

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address;
const MEME_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as Address;
const TOKEN = "0x0f24bfe09A097Bd6c424A285718b21d10E9f5F22" as Address;
const CURVE = "0xe0d8C6a8c6F4aEA8e86A613FFB5545cC9372d87A" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

function launch(overrides: Partial<LaunchedToken> = {}): LaunchedToken {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: "0x7d3a7e460425f0b407174608670889377c41E9BC" as Address,
    creatorFeeRecipient: "0x7d3a7e460425f0b407174608670889377c41E9BC" as Address,
    pairToken: NATIVE,
    graduationThreshold: 4_200_000_000_000_000_000n,
    poolFee: 0,
    tickSpacing: 200,
    creatorTaxBps: 200,
    buybackEnabled: true,
    phase: GraduationPhase.NotGraduated,
    sweptQuote: 0n,
    sweptTokens: 0n,
    sweptAt: 0n,
    exists: true,
    ...overrides,
  };
}

describe("resolveTradingVenue", () => {
  it("routes a live launch to its own curve", () => {
    const venue = resolveTradingVenue({
      launch: launch(),
      poolManager: POOL_MANAGER,
      memeHook: MEME_HOOK,
    });
    expect(venue.kind).toBe("CURVE");
    if (venue.kind === "CURVE") {
      expect(venue.curve).toBe(CURVE);
      expect(venue.pairToken).toBe(NATIVE);
    }
  });

  it("refuses to trade a SWEPT token — the bug this function exists to prevent", () => {
    const venue = resolveTradingVenue({
      launch: launch({
        phase: GraduationPhase.Swept,
        sweptQuote: 4_200_000_000_000_000_000n,
      }),
      poolManager: POOL_MANAGER,
      memeHook: MEME_HOOK,
    });
    expect(venue).toEqual({ kind: "NONE", reason: "SWEPT_AWAITING_POOL" });
  });

  it("refuses to trade a SWEPT token even if pool currencies are somehow known", () => {
    const venue = resolveTradingVenue({
      launch: launch({ phase: GraduationPhase.Swept }),
      poolManager: POOL_MANAGER,
      memeHook: MEME_HOOK,
      poolCurrencies: { currency0: NATIVE, currency1: TOKEN },
    });
    expect(venue.kind).toBe("NONE");
  });

  it("routes a graduated token to Uniswap V4 with launch-snapshotted pool params", () => {
    const venue = resolveTradingVenue({
      launch: launch({ phase: GraduationPhase.PoolCreated }),
      poolManager: POOL_MANAGER,
      memeHook: MEME_HOOK,
      poolCurrencies: { currency0: NATIVE, currency1: TOKEN },
    });
    expect(venue.kind).toBe("UNISWAP_V4");
    if (venue.kind === "UNISWAP_V4") {
      expect(venue.poolManager).toBe(POOL_MANAGER);
      expect(venue.hook).toBe(MEME_HOOK);
      expect(venue.poolFee).toBe(0);
      expect(venue.tickSpacing).toBe(200);
    }
  });

  it("withholds a venue when a graduated pool is not yet registered", () => {
    const venue = resolveTradingVenue({
      launch: launch({ phase: GraduationPhase.PoolCreated }),
      poolManager: POOL_MANAGER,
      memeHook: MEME_HOOK,
    });
    expect(venue).toEqual({ kind: "NONE", reason: "POOL_NOT_REGISTERED" });
  });

  it("treats RESCUED as terminal", () => {
    const venue = resolveTradingVenue({
      launch: launch({ phase: GraduationPhase.Rescued }),
      poolManager: POOL_MANAGER,
      memeHook: MEME_HOOK,
    });
    expect(venue).toEqual({ kind: "NONE", reason: "RESCUED_TERMINAL" });
  });

  it("never offers a venue for an address that is not a Pons launch", () => {
    // Guards against STUNKS becoming a trading UI for an arbitrary contract.
    for (const phase of [
      GraduationPhase.NotGraduated,
      GraduationPhase.Swept,
      GraduationPhase.PoolCreated,
      GraduationPhase.Rescued,
    ]) {
      const venue = resolveTradingVenue({
        launch: launch({ phase, exists: false }),
        poolManager: POOL_MANAGER,
        memeHook: MEME_HOOK,
        poolCurrencies: { currency0: NATIVE, currency1: TOKEN },
      });
      expect(venue).toEqual({ kind: "NONE", reason: "NOT_A_PONS_LAUNCH" });
    }
  });

  it("gives every no-venue reason a non-empty explanation", () => {
    for (const reason of [
      "SWEPT_AWAITING_POOL",
      "RESCUED_TERMINAL",
      "NOT_A_PONS_LAUNCH",
      "POOL_NOT_REGISTERED",
    ] as const) {
      // No bare "something went wrong" anywhere in the trading path.
      expect(describeNoVenue(reason).length).toBeGreaterThan(30);
    }
  });
});

describe("pool currency ordering", () => {
  it("sorts currency0 below currency1 as Uniswap V4 requires", () => {
    const ordered = orderPoolCurrencies(TOKEN, NATIVE);
    expect(ordered.currency0.toLowerCase() < ordered.currency1.toLowerCase()).toBe(true);
    // Native ETH is the zero address, so it always sorts first.
    expect(ordered.currency0).toBe(NATIVE);
  });

  it("is stable regardless of argument order", () => {
    expect(orderPoolCurrencies(TOKEN, NATIVE)).toEqual(
      orderPoolCurrencies(NATIVE, TOKEN),
    );
  });
});

describe("graduation progress", () => {
  it("uses the real quote reserve, not the phantom-inclusive one", () => {
    // At launch the pricing reserve reads 1.68 ETH while the real reserve is 0.
    // Progress must read 0%, not 40%.
    const progress = computeGraduationProgress({
      realQuoteReserve: 0n,
      graduationThreshold: 4_200_000_000_000_000_000n,
      sellableTokens: 714_285_714_285_714_285_714_285_715n,
      phase: GraduationPhase.NotGraduated,
    });
    expect(progress.progressBps).toBe(0n);
    expect(progress.readyToGraduate).toBe(false);
  });

  it("reports 50% at half the threshold", () => {
    const progress = computeGraduationProgress({
      realQuoteReserve: 2_100_000_000_000_000_000n,
      graduationThreshold: 4_200_000_000_000_000_000n,
      sellableTokens: 1n,
      phase: GraduationPhase.NotGraduated,
    });
    expect(progress.progressBps).toBe(5_000n);
  });

  it("gates on the token side, which is the actual on-chain trigger", () => {
    const progress = computeGraduationProgress({
      realQuoteReserve: 4_100_000_000_000_000_000n,
      graduationThreshold: 4_200_000_000_000_000_000n,
      sellableTokens: 0n,
      phase: GraduationPhase.NotGraduated,
    });
    // Quote side says 97.6%, but sellableTokens == 0 means it is ready.
    expect(progress.progressBps).toBe(9_761n);
    expect(progress.readyToGraduate).toBe(true);
  });

  it("clamps to 100% and never exceeds it", () => {
    const progress = computeGraduationProgress({
      realQuoteReserve: 9_000_000_000_000_000_000n,
      graduationThreshold: 4_200_000_000_000_000_000n,
      sellableTokens: 0n,
      phase: GraduationPhase.NotGraduated,
    });
    expect(progress.progressBps).toBe(10_000n);
  });

  it("reports 100% for every post-curve phase", () => {
    for (const phase of [
      GraduationPhase.Swept,
      GraduationPhase.PoolCreated,
      GraduationPhase.Rescued,
    ]) {
      const progress = computeGraduationProgress({
        realQuoteReserve: 0n,
        graduationThreshold: 4_200_000_000_000_000_000n,
        sellableTokens: 0n,
        phase,
      });
      expect(progress.progressBps).toBe(10_000n);
      // Already graduated, so not "ready to graduate".
      expect(progress.readyToGraduate).toBe(false);
    }
  });
});

describe("phase parsing and labels", () => {
  it("maps the on-chain enum values", () => {
    expect(parseGraduationPhase(0)).toBe(GraduationPhase.NotGraduated);
    expect(parseGraduationPhase(1)).toBe(GraduationPhase.Swept);
    expect(parseGraduationPhase(2)).toBe(GraduationPhase.PoolCreated);
    expect(parseGraduationPhase(3)).toBe(GraduationPhase.Rescued);
  });

  it("throws on an unknown phase rather than guessing a venue", () => {
    expect(() => parseGraduationPhase(4)).toThrow(/unknown graduationphase/i);
  });

  it("marks only curve and pool phases tradeable", () => {
    expect(isTradeablePhase(GraduationPhase.NotGraduated)).toBe(true);
    expect(isTradeablePhase(GraduationPhase.PoolCreated)).toBe(true);
    expect(isTradeablePhase(GraduationPhase.Swept)).toBe(false);
    expect(isTradeablePhase(GraduationPhase.Rescued)).toBe(false);
  });

  it("labels the pending-pool state explicitly", () => {
    expect(describePhase(GraduationPhase.Swept)).toMatch(/not yet created/i);
  });
});
