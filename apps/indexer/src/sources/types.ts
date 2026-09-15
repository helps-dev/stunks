import type { Address, Hex } from "viem";

/**
 * Log source abstraction.
 *
 * This exists because measurement forced it, not for elegance. Measured on
 * Robinhood Chain:
 *
 *   drpc      widest eth_getLogs window 100 blocks (rejected at 250)
 *             -> 367,905 calls to backfill 36.8M blocks ≈ 51 hours at 2 req/s
 *   ordofi    eth_getLogs unusable entirely (fine for eth_call)
 *   HyperSync supported for chain 4663 and tracking head
 *
 * So live tailing and backfill have genuinely different needs: tailing ~10
 * blocks/sec is trivial over RPC, while backfill over RPC is not viable at all.
 * Making the source pluggable means that choice is configuration rather than a
 * rewrite.
 */

export interface RawLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface LogQuery {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /** Empty means "any address" — used for per-curve subscriptions that grow. */
  readonly addresses: readonly Address[];
  /** Optional topic0 filter. */
  readonly topics0?: readonly Hex[];
}

export interface LogBatch {
  readonly logs: readonly RawLog[];
  /**
   * The block this batch actually covered up to. A source may return less than
   * requested — HyperSync paginates, and an RPC window may be narrowed on the fly.
   * The scanner must checkpoint to THIS value, never to the requested toBlock, or
   * it will silently skip blocks.
   */
  readonly reachedBlock: bigint;
}

export interface LogSource {
  readonly name: string;
  /** Chain head as this source sees it. */
  head(): Promise<bigint>;
  getLogs(query: LogQuery): Promise<LogBatch>;
  /**
   * Block hash for reorg detection. Not every fast source exposes this cheaply,
   * so it may fall back to RPC.
   */
  blockHash(blockNumber: bigint): Promise<Hex>;
}

/** Thrown when a source cannot serve a range and the caller must narrow it. */
export class RangeTooWideError extends Error {
  constructor(
    readonly attempted: bigint,
    message: string,
  ) {
    super(message);
    this.name = "RangeTooWideError";
  }
}
