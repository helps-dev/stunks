/**
 * Log-range splitting.
 *
 * Measured during the audit against a free archive endpoint: a 100-block
 * eth_getLogs window succeeded, a 500-block window was rejected — and the error
 * message claimed the limit was 10,000 blocks, which it plainly was not. So the
 * window size cannot be inferred from the error text and must be adaptive.
 *
 * Scale context: at ~852,912 blocks/day, and 36.6M blocks between the factory
 * deployment and head, window size is the difference between a feasible backfill
 * and an impossible one. This helper exists so that arithmetic is explicit rather
 * than buried in the indexer.
 */

export const DEFAULT_MAX_LOG_RANGE = 100n;

export interface BlockRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

/** Inclusive block count of a range. */
export function rangeSize(range: BlockRange): bigint {
  return range.toBlock - range.fromBlock + 1n;
}

/**
 * Split an inclusive range into windows of at most `maxSpan` blocks.
 * Throws rather than silently returning nothing for an inverted range, because a
 * silently empty scan looks identical to "no events happened".
 */
export function splitBlockRange(
  fromBlock: bigint,
  toBlock: bigint,
  maxSpan: bigint = DEFAULT_MAX_LOG_RANGE,
): BlockRange[] {
  if (maxSpan <= 0n) throw new Error(`splitBlockRange: maxSpan must be positive`);
  if (toBlock < fromBlock) {
    throw new Error(`splitBlockRange: inverted range ${fromBlock}..${toBlock}`);
  }

  const windows: BlockRange[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + maxSpan - 1n;
    windows.push({ fromBlock: cursor, toBlock: end > toBlock ? toBlock : end });
    cursor = end + 1n;
  }
  return windows;
}

/**
 * Successful scans at the settled span before one probe above it.
 *
 * A provider's limit is a plan setting, not a law, so a higher one must be
 * rediscoverable. But each probe above a known-bad size costs a whole tick, so it has
 * to be rare: at roughly one tick per second, 200 is about once every three minutes.
 */
const CEILING_REPROBE_INTERVAL = 200;

/**
 * Adaptive window sizer: a binary search for whatever an endpoint actually tolerates.
 *
 * It cannot be inferred from the error text. Measured on dRPC's free plan,
 * 2026-09-17: the real `eth_getLogs` ceiling is exactly 100 blocks, while the
 * rejection message claims "ranges over 10000 blocks are not supported".
 *
 * The sizer holds two facts — the largest span known to SUCCEED and the smallest
 * known to FAIL — and moves to the midpoint between them. That converges on the true
 * limit in a handful of rejections and then stops moving, which is the property that
 * matters: every rejection costs a whole tick that scanned nothing.
 *
 * Pure additive-increase, which this replaces, never stopped. Against a hard limit of
 * 100 it cycled forever — 100 succeeds, grow to 126, rejected, halve to 63, climb 79,
 * 99, 124, rejected — spending about one tick in four rediscovering a limit that had
 * not changed, and averaging a window near 85 instead of 100.
 */
export class AdaptiveLogWindow {
  private span: bigint;
  /** Largest span observed to succeed. Zero until one does. */
  private lastGood = 0n;
  /** Smallest span observed to fail. Null until one does. */
  private ceiling: bigint | null = null;
  private successesAtSettled = 0;

  constructor(
    initialSpan: bigint = DEFAULT_MAX_LOG_RANGE,
    private readonly minSpan: bigint = 10n,
    private readonly maxSpan: bigint = 10_000n,
  ) {
    if (initialSpan <= 0n)
      throw new Error("AdaptiveLogWindow: initialSpan must be positive");
    this.span = initialSpan;
  }

  current(): bigint {
    return this.span;
  }

  /** The smallest rejected span observed so far, for diagnostics. */
  knownCeiling(): bigint | null {
    return this.ceiling;
  }

  /** True once the search has bracketed the limit and stopped moving. */
  settled(): boolean {
    return this.ceiling !== null && this.ceiling - this.lastGood <= 1n;
  }

  private clamp(value: bigint): bigint {
    if (value < this.minSpan) return this.minSpan;
    return value > this.maxSpan ? this.maxSpan : value;
  }

  onRejected(): bigint {
    this.ceiling =
      this.ceiling === null || this.span < this.ceiling ? this.span : this.ceiling;
    this.successesAtSettled = 0;

    // Midpoint between the best known-good span and the new bound. With no success
    // recorded yet `lastGood` is 0, so this is exactly the old halving behaviour.
    this.span = this.clamp((this.lastGood + this.ceiling) / 2n);
    return this.span;
  }

  onSuccess(): bigint {
    if (this.span > this.lastGood) this.lastGood = this.span;

    // A span at or above the remembered bound just succeeded, so the bound was wrong
    // or the plan was raised. Drop it and resume searching upward.
    if (this.ceiling !== null && this.span >= this.ceiling) {
      this.ceiling = null;
      this.successesAtSettled = 0;
    }

    if (this.ceiling === null) {
      // No upper bound known: grow geometrically to find one.
      this.span = this.clamp(this.span + this.span / 4n + 1n);
      return this.span;
    }

    if (this.ceiling - this.lastGood > 1n) {
      // Still bracketing. Step to the midpoint.
      this.span = this.clamp((this.lastGood + this.ceiling) / 2n);
      return this.span;
    }

    // Settled on the true limit. Sit there, and only occasionally spend a tick
    // checking whether it has moved.
    this.successesAtSettled += 1;
    if (this.successesAtSettled >= CEILING_REPROBE_INTERVAL) {
      this.successesAtSettled = 0;
      this.span = this.clamp(this.ceiling);
      return this.span;
    }
    this.span = this.clamp(this.lastGood);
    return this.span;
  }
}

/** Estimate wall-clock seconds a block delta represents, for lag reporting. */
export function blocksToSeconds(blocks: bigint, blockTimeSeconds: number): number {
  // eslint-disable-next-line no-restricted-syntax -- block counts are not money; this is a human-readable lag estimate
  return Number(blocks) * blockTimeSeconds;
}
