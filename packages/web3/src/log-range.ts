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
 * Adaptive window sizer. Halves on a range rejection, grows slowly on success, so
 * the indexer converges on whatever an endpoint actually tolerates instead of
 * trusting its error messages.
 */
export class AdaptiveLogWindow {
  private span: bigint;

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

  onRejected(): bigint {
    const halved = this.span / 2n;
    this.span = halved < this.minSpan ? this.minSpan : halved;
    return this.span;
  }

  onSuccess(): bigint {
    const grown = this.span + this.span / 4n + 1n;
    this.span = grown > this.maxSpan ? this.maxSpan : grown;
    return this.span;
  }
}

/** Estimate wall-clock seconds a block delta represents, for lag reporting. */
export function blocksToSeconds(blocks: bigint, blockTimeSeconds: number): number {
  // eslint-disable-next-line no-restricted-syntax -- block counts are not money; this is a human-readable lag estimate
  return Number(blocks) * blockTimeSeconds;
}
