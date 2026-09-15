import type { Hex } from "viem";

/**
 * Reorg detection.
 *
 * Robinhood Chain is an Arbitrum Orbit L2 and its practical reorg depth is not
 * documented in anything we could verify. So this does not assume a depth — it
 * detects divergence by comparing the hash we recorded for a block against the hash
 * the chain reports now, and it only treats blocks below a configurable confirmation
 * depth as settled.
 *
 * The cost of a confirmation delay here is unusually low: at ~101 ms per block, a
 * depth of 12 blocks is about 1.2 seconds of added latency. There is no reason to be
 * aggressive about it.
 */

/** ~1.2 seconds at this chain's measured block time. */
export const DEFAULT_CONFIRMATION_DEPTH = 12;

export interface ReorgCheckInput {
  /** Hash recorded when this block was last processed. Null on a fresh start. */
  readonly recordedHash: string | null;
  readonly recordedBlock: bigint;
  /** Hash the chain reports for `recordedBlock` right now. */
  readonly currentHash: Hex;
}

export type ReorgVerdict =
  | { readonly kind: "OK" }
  | { readonly kind: "UNVERIFIABLE"; readonly reason: string }
  | {
      readonly kind: "REORG";
      readonly rollbackTo: bigint;
      readonly recordedHash: string;
      readonly currentHash: Hex;
    };

/**
 * Compare the recorded checkpoint hash against the chain.
 *
 * A missing recorded hash is reported as UNVERIFIABLE rather than OK. That
 * distinction matters: it happens on a fresh checkpoint and immediately after a
 * rollback, and silently treating it as "no reorg" would hide the one case where we
 * genuinely do not know.
 */
export function checkForReorg(
  input: ReorgCheckInput,
  rollbackDepth: number = DEFAULT_CONFIRMATION_DEPTH,
): ReorgVerdict {
  if (input.recordedHash === null) {
    return { kind: "UNVERIFIABLE", reason: "no recorded block hash to compare against" };
  }

  if (input.recordedHash.toLowerCase() === input.currentHash.toLowerCase()) {
    return { kind: "OK" };
  }

  // Rewind past the divergence, not just to it. The orphaned block's parent may also
  // have been replaced, and re-scanning a few hundred milliseconds of blocks costs
  // nothing compared to persisting a trade that no longer exists.
  const depth = BigInt(rollbackDepth);
  const target = input.recordedBlock > depth ? input.recordedBlock - depth : 0n;

  return {
    kind: "REORG",
    rollbackTo: target,
    recordedHash: input.recordedHash,
    currentHash: input.currentHash,
  };
}

/**
 * Highest block safe to treat as final.
 *
 * Returns null when the chain is younger than the confirmation depth, rather than
 * clamping to zero — a caller that received 0n could mistake it for "scan from
 * genesis", which on this chain would be 63 million wasted blocks.
 */
export function safeHead(
  chainHead: bigint,
  confirmationDepth: number = DEFAULT_CONFIRMATION_DEPTH,
): bigint | null {
  const depth = BigInt(confirmationDepth);
  if (chainHead <= depth) return null;
  return chainHead - depth;
}

/**
 * Verify that a batch of blocks forms an unbroken chain.
 *
 * Used on live tailing, where consecutive blocks are fetched anyway. A gap in the
 * parent links means a reorg landed mid-batch, and processing it would write logs
 * from two incompatible histories.
 */
export function verifyLineage(
  blocks: readonly { number: bigint; hash: Hex; parentHash: Hex }[],
): { ok: true } | { ok: false; brokenAt: bigint } {
  for (let index = 1; index < blocks.length; index++) {
    const previous = blocks[index - 1];
    const current = blocks[index];
    if (!previous || !current) continue;
    if (current.parentHash.toLowerCase() !== previous.hash.toLowerCase()) {
      return { ok: false, brokenAt: current.number };
    }
  }
  return { ok: true };
}
