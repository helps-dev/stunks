import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRENDING_WEIGHTS,
  scoreTrending,
  validateWeights,
  type TrendingInput,
} from "./trending.js";

const ETH = 1_000_000_000_000_000_000n;

function token(id: string, overrides: Partial<TrendingInput> = {}): TrendingInput {
  return {
    tokenId: id,
    recentVolume: ETH,
    priorVolume: ETH,
    uniqueTraders: 10,
    tradeCount: 20,
    buyVolume: ETH / 2n,
    sellVolume: ETH / 2n,
    marketCap: 10n * ETH,
    priorMarketCap: 10n * ETH,
    ...overrides,
  };
}

describe("weights", () => {
  it("matches the PRD defaults and sums to 100", () => {
    expect(DEFAULT_TRENDING_WEIGHTS).toEqual({
      volumeAcceleration: 30,
      uniqueTraders: 25,
      tradeActivity: 20,
      buyPressure: 15,
      marketCapGrowth: 10,
    });
    expect(validateWeights(DEFAULT_TRENDING_WEIGHTS)).toEqual([]);
  });

  it("rejects weights that do not sum to 100", () => {
    const errors = validateWeights({ ...DEFAULT_TRENDING_WEIGHTS, uniqueTraders: 50 });
    expect(errors[0]).toMatch(/must sum to 100, got 125/);
  });

  it("is configurable, not hardcoded", () => {
    // The PRD requires the weights be changeable without a code change.
    const volumeOnly = {
      volumeAcceleration: 100,
      uniqueTraders: 0,
      tradeActivity: 0,
      buyPressure: 0,
      marketCapGrowth: 0,
    };
    expect(validateWeights(volumeOnly)).toEqual([]);

    const scores = scoreTrending(
      [
        token("accelerating", { recentVolume: 10n * ETH, priorVolume: ETH }),
        token("flat", { uniqueTraders: 9_999, tradeCount: 9_999 }),
      ],
      volumeOnly,
    );
    // With traders and activity weighted at zero, only acceleration can win.
    const accelerating = scores.find((s) => s.tokenId === "accelerating");
    const flat = scores.find((s) => s.tokenId === "flat");
    expect(accelerating!.scoreBps).toBeGreaterThan(flat!.scoreBps);
  });

  it("throws rather than silently scoring with invalid weights", () => {
    expect(() =>
      scoreTrending([token("a")], { ...DEFAULT_TRENDING_WEIGHTS, buyPressure: 99 }),
    ).toThrow(/sum to 100/);
  });
});

describe("normalisation", () => {
  it("ranks relative to the cohort, not on absolute size", () => {
    // A token with huge absolute numbers but no growth should not automatically win.
    // Ranking on raw volume would make trending a synonym for "biggest".
    const scores = scoreTrending([
      token("whale", {
        recentVolume: 1_000n * ETH,
        priorVolume: 1_000n * ETH,
        uniqueTraders: 5,
        tradeCount: 5,
      }),
      token("riser", {
        recentVolume: 2n * ETH,
        priorVolume: ETH,
        uniqueTraders: 50,
        tradeCount: 80,
        buyVolume: (2n * ETH * 8n) / 10n,
        sellVolume: (2n * ETH * 2n) / 10n,
      }),
    ]);

    const whale = scores.find((s) => s.tokenId === "whale")!;
    const riser = scores.find((s) => s.tokenId === "riser")!;
    expect(riser.scoreBps).toBeGreaterThan(whale.scoreBps);
  });

  it("keeps every score inside 0..10000", () => {
    const scores = scoreTrending([
      token("a", { recentVolume: 10_000n * ETH, priorVolume: 1n, uniqueTraders: 5_000 }),
      token("b", { recentVolume: 0n, priorVolume: ETH, uniqueTraders: 0, tradeCount: 0 }),
    ]);
    for (const score of scores) {
      expect(score.scoreBps).toBeGreaterThanOrEqual(0n);
      expect(score.scoreBps).toBeLessThanOrEqual(10_000n);
    }
  });

  it("returns an empty result for an empty cohort", () => {
    expect(scoreTrending([])).toEqual([]);
  });
});

describe("manipulation resistance", () => {
  it("caps volume acceleration so a wash trade cannot swamp the score", () => {
    // Going from dust to 1 ETH is a ~100,000% increase. Uncapped, that single component
    // would drown out every honest signal — exactly the cheap trick to defend against.
    const scores = scoreTrending([
      token("washer", {
        recentVolume: ETH,
        priorVolume: 1n,
        uniqueTraders: 1,
        tradeCount: 2,
        buyVolume: ETH,
        sellVolume: 0n,
      }),
      token("organic", {
        recentVolume: 2n * ETH,
        priorVolume: ETH,
        uniqueTraders: 40,
        tradeCount: 60,
        buyVolume: (2n * ETH * 6n) / 10n,
        sellVolume: (2n * ETH * 4n) / 10n,
      }),
    ]);

    const washer = scores.find((s) => s.tokenId === "washer")!;
    const organic = scores.find((s) => s.tokenId === "organic")!;
    // Unique traders is the component that costs real money to fake: every extra
    // trader needs its own funded wallet.
    expect(organic.scoreBps).toBeGreaterThan(washer.scoreBps);
  });

  it("treats no prior volume as strong but bounded signal", () => {
    const [score] = scoreTrending([
      token("fresh", { recentVolume: ETH, priorVolume: 0n }),
    ]);
    expect(score!.components.volumeAcceleration.raw).toBe(10_000n);
  });

  it("gives a shrinking token no acceleration credit", () => {
    const [score] = scoreTrending([
      token("fading", { recentVolume: ETH / 2n, priorVolume: ETH }),
    ]);
    expect(score!.components.volumeAcceleration.raw).toBe(0n);
  });
});

describe("buy pressure", () => {
  it("is 5000 bps when buys and sells balance", () => {
    const [score] = scoreTrending([
      token("balanced", { buyVolume: ETH, sellVolume: ETH }),
    ]);
    expect(score!.components.buyPressure.raw).toBe(5_000n);
  });

  it("is 10000 bps for buys only", () => {
    const [score] = scoreTrending([token("bullish", { buyVolume: ETH, sellVolume: 0n })]);
    expect(score!.components.buyPressure.raw).toBe(10_000n);
  });

  it("is zero when nothing traded, rather than dividing by zero", () => {
    const [score] = scoreTrending([token("silent", { buyVolume: 0n, sellVolume: 0n })]);
    expect(score!.components.buyPressure.raw).toBe(0n);
  });
});

describe("component transparency", () => {
  it("exposes raw and normalised values so a rank can be explained", () => {
    const [score] = scoreTrending([token("a", { uniqueTraders: 42, tradeCount: 99 })]);
    expect(score!.components.uniqueTraders.raw).toBe(42n);
    expect(score!.components.tradeActivity.raw).toBe(99n);
    expect(score!.components.uniqueTraders.weight).toBe(25);
    // A lone token is its own cohort maximum.
    expect(score!.components.uniqueTraders.normalisedBps).toBe(10_000n);
  });
});
