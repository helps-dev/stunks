import { BLOCK_TIME_SECONDS } from "@stunks/config";

/**
 * How current the indexed data is.
 *
 * Pure on purpose: the selection rule below is the whole point of this module and it
 * needs a test that does not require a database.
 *
 * THE RULE: freshness is the SLOWEST required stream, never the fastest.
 *
 * This was wrong once, and the way it was wrong is worth recording. It reported the
 * factory stream alone. But a token exists because the factory saw its launch, while
 * its price, market cap, volume and trade counts exist because the CURVE stream saw
 * its trades — and the curve stream is capped at the factory checkpoint, so it is
 * structurally the one that falls behind. Measured on 2026-09-17: factory 361 blocks
 * behind (37 s), curves 715,288 blocks behind (~20 h). The banner said "37 seconds
 * behind" while every price on the page was twenty hours old.
 *
 * That is exactly the claim invariant 4 exists to prevent, so the rule is now
 * structural rather than a matter of picking the right string.
 */

/** Both streams bound what a page can honestly claim. Neither may be omitted. */
export const REQUIRED_STREAMS = ["factory", "curves"] as const;

/** A minute of lag is ~600 blocks on this chain, which is normal. Ten minutes is not. */
export const STALE_AFTER_SECONDS = 600;

export interface StreamState {
  readonly stream: string;
  readonly lastProcessedBlock: bigint;
  readonly lastSuccessAt: Date | null;
  readonly isPaused: boolean;
}

export interface StreamStaleness {
  readonly stream: string;
  readonly indexedBlock: string;
  readonly lagBlocks: string | null;
  readonly lagSeconds: number | null;
  readonly lastSuccessAt: string | null;
  readonly isPaused: boolean;
}

export interface IndexerStaleness {
  /** The slowest required stream — the one that actually bounds what is on screen. */
  readonly stream: string | null;
  readonly indexedBlock: string | null;
  readonly chainHead: string | null;
  readonly lagBlocks: string | null;
  readonly lagSeconds: number | null;
  readonly lastSuccessAt: string | null;
  readonly isStale: boolean;
  /** Every required stream, so a page can show where the backlog actually is. */
  readonly streams: readonly StreamStaleness[];
}

/** Blocks behind, clamped at zero: a stream may briefly report past a lagging head. */
export function lagBlocks(chainHead: bigint | null, indexedBlock: bigint): bigint | null {
  if (chainHead === null) return null;
  return chainHead > indexedBlock ? chainHead - indexedBlock : 0n;
}

export function lagSeconds(
  chainHead: bigint | null,
  indexedBlock: bigint,
): number | null {
  const blocks = lagBlocks(chainHead, indexedBlock);
  if (blocks === null) return null;
  // eslint-disable-next-line no-restricted-syntax -- a block count is not money; this is a human-readable estimate
  return Math.round(Number(blocks) * BLOCK_TIME_SECONDS);
}

function describe(state: StreamState, chainHead: bigint | null): StreamStaleness {
  return {
    stream: state.stream,
    indexedBlock: state.lastProcessedBlock.toString(),
    lagBlocks: lagBlocks(chainHead, state.lastProcessedBlock)?.toString() ?? null,
    lagSeconds: lagSeconds(chainHead, state.lastProcessedBlock),
    lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
    isPaused: state.isPaused,
  };
}

/** The shape returned when freshness genuinely cannot be established. */
function unknown(chainHead: bigint | null): IndexerStaleness {
  return {
    stream: null,
    indexedBlock: null,
    chainHead: chainHead?.toString() ?? null,
    lagBlocks: null,
    lagSeconds: null,
    lastSuccessAt: null,
    isStale: true,
    streams: [],
  };
}

export function summariseStaleness(
  states: readonly StreamState[],
  chainHead: bigint | null,
): IndexerStaleness {
  const required = REQUIRED_STREAMS.map((name) =>
    states.find((state) => state.stream === name),
  );

  // A missing stream is not "no lag", it is "we do not know". Report the honest one.
  if (required.some((state) => state === undefined)) return unknown(chainHead);
  const present = required as StreamState[];

  // A figure is only as fresh as the slowest input that produced it.
  const binding = present.reduce((slowest, state) =>
    state.lastProcessedBlock < slowest.lastProcessedBlock ? state : slowest,
  );

  const seconds = lagSeconds(chainHead, binding.lastProcessedBlock);

  return {
    stream: binding.stream,
    indexedBlock: binding.lastProcessedBlock.toString(),
    chainHead: chainHead?.toString() ?? null,
    lagBlocks: lagBlocks(chainHead, binding.lastProcessedBlock)?.toString() ?? null,
    lagSeconds: seconds,
    lastSuccessAt: binding.lastSuccessAt?.toISOString() ?? null,
    // A paused stream is stale whatever its block number says: it is not advancing.
    isStale:
      seconds === null ||
      seconds > STALE_AFTER_SECONDS ||
      present.some((state) => state.isPaused),
    streams: present.map((state) => describe(state, chainHead)),
  };
}
