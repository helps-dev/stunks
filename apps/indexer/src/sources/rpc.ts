import type { Hex, PublicClient } from "viem";
import { AdaptiveLogWindow, RpcCallError } from "@stunks/web3";
import {
  RangeTooWideError,
  type LogBatch,
  type LogQuery,
  type LogSource,
} from "./types.js";

/**
 * RPC log source.
 *
 * Suitable for live tailing, where each tick covers a handful of blocks. NOT
 * suitable for backfill: the widest window a free endpoint accepted was 100 blocks,
 * which puts a full 36.8M-block backfill at ~51 hours.
 *
 * The window size is adaptive because endpoints misreport their own limits. One
 * rejected a 250-block range while its error message claimed the limit was 10,000.
 * So the working value is discovered by halving on rejection, and it is persisted in
 * the checkpoint so a restart does not have to relearn it.
 */
export class RpcLogSource implements LogSource {
  readonly name = "rpc";
  private readonly window: AdaptiveLogWindow;

  constructor(
    private readonly client: PublicClient,
    initialWindow = 100n,
  ) {
    this.window = new AdaptiveLogWindow(initialWindow, 10n, 10_000n);
  }

  /** Current window size, so the scanner can persist it. */
  windowSize(): bigint {
    return this.window.current();
  }

  async head(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async blockHash(blockNumber: bigint): Promise<Hex> {
    const block = await this.client.getBlock({ blockNumber });
    return block.hash;
  }

  async getLogs(query: LogQuery): Promise<LogBatch> {
    // Clamp the request to what this endpoint currently tolerates. The scanner asks
    // for what it wants; the source answers with what it could actually deliver.
    const requested = query.toBlock - query.fromBlock + 1n;
    const allowed = this.window.current();
    const toBlock = requested > allowed ? query.fromBlock + allowed - 1n : query.toBlock;

    try {
      const logs = await this.client.getLogs({
        ...(query.addresses.length > 0 ? { address: [...query.addresses] } : {}),
        fromBlock: query.fromBlock,
        toBlock,
      });

      this.window.onSuccess();

      return {
        logs: logs
          .filter(
            (log) =>
              log.blockNumber !== null &&
              log.blockHash !== null &&
              log.transactionHash !== null &&
              log.logIndex !== null,
          )
          .filter(
            (log) =>
              query.topics0 === undefined ||
              (log.topics[0] !== undefined && query.topics0.includes(log.topics[0])),
          )
          .map((log) => ({
            address: log.address,
            topics: log.topics,
            data: log.data,
            blockNumber: log.blockNumber as bigint,
            blockHash: log.blockHash as Hex,
            transactionHash: log.transactionHash as Hex,
            logIndex: log.logIndex as number,
          })),
        reachedBlock: toBlock,
      };
    } catch (error) {
      if (error instanceof RpcCallError && error.kind === "LOG_RANGE_TOO_WIDE") {
        const narrowed = this.window.onRejected();
        throw new RangeTooWideError(
          toBlock - query.fromBlock + 1n,
          `Endpoint rejected the range; window narrowed to ${narrowed}. Retry.`,
        );
      }
      throw error;
    }
  }
}
