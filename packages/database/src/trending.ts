import { BASIS_POINTS, ratioBps } from "@stunks/utils";

/**
 * Trending score.
 *
 * The PRD specifies weights of 30% volume acceleration, 25% unique traders, 20% trade
 * activity, 15% buy pressure and 10% market-cap growth, and requires that they be
 * configurable rather than baked in. `DEFAULT_TRENDING_WEIGHTS` is the starting point,
 * not a constant.
 *
 * Two design decisions worth stating.
 *
 * NORMALISED, NOT RAW. Every component is scored 0..10000 against the cohort being
 * ranked, so a token cannot dominate simply by having large absolute numbers. Ranking
 * on raw volume would make trending a synonym for "biggest", which the PRD explicitly
 * rejects.
 *
 * MANIPULATION-AWARE. At the observed launch rate a creator can trivially spin up a
 * token and wash-trade it. So volume acceleration is capped, and unique traders is
 * weighted heavily precisely because it is the component that costs real money to fake
 * — every extra trader needs its own funded wallet.
 *
 * Scores are integers throughout, in basis points. No floats.
 */

export interface TrendingWeights {
  readonly volumeAcceleration: number;
  readonly uniqueTraders: number;
  readonly tradeActivity: number;
  readonly buyPressure: number;
  readonly marketCapGrowth: number;
}

/** From the PRD. Must sum to 100. */
export const DEFAULT_TRENDING_WEIGHTS: TrendingWeights = {
  volumeAcceleration: 30,
  uniqueTraders: 25,
  tradeActivity: 20,
  buyPressure: 15,
  marketCapGrowth: 10,
};

export function validateWeights(weights: TrendingWeights): string[] {
  const errors: string[] = [];
  const total =
    weights.volumeAcceleration +
    weights.uniqueTraders +
    weights.tradeActivity +
    weights.buyPressure +
    weights.marketCapGrowth;
  if (total !== 100) {
    errors.push(`Trending weights must sum to 100, got ${total}.`);
  }
  for (const [key, value] of Object.entries(weights)) {
    if (!Number.isInteger(value) || value < 0) {
      errors.push(`Weight ${key} must be a non-negative integer.`);
    }
  }
  return errors;
}

/** Raw per-token inputs, all measured from indexed on-chain trades. */
export interface TrendingInput {
  readonly tokenId: string;
  /** Quote-leg volume in the recent window. */
  readonly recentVolume: bigint;
  /** Quote-leg volume in the window before it, for acceleration. */
  readonly priorVolume: bigint;
  readonly uniqueTraders: number;
  readonly tradeCount: number;
  readonly buyVolume: bigint;
  readonly sellVolume: bigint;
  readonly marketCap: bigint;
  readonly priorMarketCap: bigint;
}

export interface TrendingComponent {
  readonly raw: bigint;
  readonly normalisedBps: bigint;
  readonly weight: number;
}

export interface TrendingScore {
  readonly tokenId: string;
  /** 0..10000. */
  readonly scoreBps: bigint;
  readonly components: {
    readonly volumeAcceleration: TrendingComponent;
    readonly uniqueTraders: TrendingComponent;
    readonly tradeActivity: TrendingComponent;
    readonly buyPressure: TrendingComponent;
    readonly marketCapGrowth: TrendingComponent;
  };
}

/**
 * Growth ratio in basis points, capped.
 *
 * The cap is the anti-manipulation measure that matters most here. A token going from
 * 0.001 to 1 ETH of volume is a 100,000% increase, and without a ceiling that single
 * component would swamp every other signal — which is exactly the cheap trick a wash
 * trader would reach for. `10000` bps (a 1x increase) is treated as the top of the
 * scale.
 */
const MAX_GROWTH_BPS = 10_000n;

function growthBps(recent: bigint, prior: bigint): bigint {
  if (recent <= 0n) return 0n;
  // No prior activity is real signal, but it is not unbounded signal.
  if (prior <= 0n) return MAX_GROWTH_BPS;
  if (recent <= prior) return 0n;
  const growth = ratioBps(recent - prior, prior);
  return growth > MAX_GROWTH_BPS ? MAX_GROWTH_BPS : growth;
}

/** Buy share of volume, in bps. 5000 means perfectly balanced. */
function buyPressureBps(buyVolume: bigint, sellVolume: bigint): bigint {
  const total = buyVolume + sellVolume;
  if (total <= 0n) return 0n;
  return ratioBps(buyVolume, total);
}

/** Scale a value against the cohort maximum, so components are comparable. */
function normalise(value: bigint, max: bigint): bigint {
  if (max <= 0n) return 0n;
  if (value >= max) return BASIS_POINTS;
  return ratioBps(value, max);
}

/**
 * Score a cohort together.
 *
 * Takes the whole set rather than one token at a time, because normalisation is only
 * meaningful relative to the group being ranked. A per-token function would have no
 * denominator and would quietly degrade into raw-value ranking.
 */
export function scoreTrending(
  inputs: readonly TrendingInput[],
  weights: TrendingWeights = DEFAULT_TRENDING_WEIGHTS,
): TrendingScore[] {
  const errors = validateWeights(weights);
  if (errors.length > 0) throw new Error(errors.join(" "));
  if (inputs.length === 0) return [];

  const raw = inputs.map((input) => ({
    tokenId: input.tokenId,
    volumeAcceleration: growthBps(input.recentVolume, input.priorVolume),
    uniqueTraders: BigInt(Math.max(0, input.uniqueTraders)),
    tradeActivity: BigInt(Math.max(0, input.tradeCount)),
    buyPressure: buyPressureBps(input.buyVolume, input.sellVolume),
    marketCapGrowth: growthBps(input.marketCap, input.priorMarketCap),
  }));

  const max = {
    volumeAcceleration: maxOf(raw.map((r) => r.volumeAcceleration)),
    uniqueTraders: maxOf(raw.map((r) => r.uniqueTraders)),
    tradeActivity: maxOf(raw.map((r) => r.tradeActivity)),
    // Already a bounded ratio, so its own scale is the denominator.
    buyPressure: BASIS_POINTS,
    marketCapGrowth: maxOf(raw.map((r) => r.marketCapGrowth)),
  };

  return raw.map((entry) => {
    const components = {
      volumeAcceleration: component(
        entry.volumeAcceleration,
        max.volumeAcceleration,
        weights.volumeAcceleration,
      ),
      uniqueTraders: component(
        entry.uniqueTraders,
        max.uniqueTraders,
        weights.uniqueTraders,
      ),
      tradeActivity: component(
        entry.tradeActivity,
        max.tradeActivity,
        weights.tradeActivity,
      ),
      buyPressure: component(entry.buyPressure, max.buyPressure, weights.buyPressure),
      marketCapGrowth: component(
        entry.marketCapGrowth,
        max.marketCapGrowth,
        weights.marketCapGrowth,
      ),
    };

    // Weighted mean of normalised components, kept in bps by dividing by 100.
    const weighted =
      components.volumeAcceleration.normalisedBps * BigInt(weights.volumeAcceleration) +
      components.uniqueTraders.normalisedBps * BigInt(weights.uniqueTraders) +
      components.tradeActivity.normalisedBps * BigInt(weights.tradeActivity) +
      components.buyPressure.normalisedBps * BigInt(weights.buyPressure) +
      components.marketCapGrowth.normalisedBps * BigInt(weights.marketCapGrowth);

    return { tokenId: entry.tokenId, scoreBps: weighted / 100n, components };
  });
}

function component(raw: bigint, max: bigint, weight: number): TrendingComponent {
  return { raw, normalisedBps: normalise(raw, max), weight };
}

function maxOf(values: readonly bigint[]): bigint {
  return values.reduce((best, value) => (value > best ? value : best), 0n);
}
