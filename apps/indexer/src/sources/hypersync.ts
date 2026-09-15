import type { Address, Hex, PublicClient } from "viem";
import type { LogBatch, LogQuery, LogSource, RawLog } from "./types.js";

/**
 * Envio HyperSync log source, for backfill.
 *
 * Verified during the Phase 0 follow-up: HyperSync serves chain 4663 and tracks its
 * head (measured lag of ~113 blocks, i.e. about eleven seconds). Its /height
 * endpoint is unauthenticated, which is how support was confirmed without a token;
 * queries need a free bearer token from https://app.envio.dev/api-tokens.
 *
 * It exists because RPC backfill is not viable here: 36.8M blocks at a 100-block
 * window and ~2 req/s is roughly 51 hours. HyperSync answers millions of blocks per
 * request.
 *
 * Block hashes are delegated to RPC. HyperSync can return them, but the scanner only
 * needs a hash at the confirmation boundary, so it is not worth widening the field
 * selection on every backfill page.
 */

interface HyperSyncLog {
  block_number?: number;
  transaction_hash?: string;
  log_index?: number;
  address?: string;
  data?: string;
  topic0?: string | null;
  topic1?: string | null;
  topic2?: string | null;
  topic3?: string | null;
  block_hash?: string;
}

interface HyperSyncResponse {
  data?: { logs?: HyperSyncLog[] }[];
  /** First block NOT covered by this response. */
  next_block?: number;
  archive_height?: number;
}

export interface HyperSyncOptions {
  readonly url?: string;
  readonly bearerToken: string;
  /** Falls back to RPC for block hashes. */
  readonly rpcClient: PublicClient;
  readonly timeoutMs?: number;
}

export class HyperSyncLogSource implements LogSource {
  readonly name = "hypersync";
  private readonly url: string;
  private readonly token: string;
  private readonly rpc: PublicClient;
  private readonly timeoutMs: number;

  constructor(options: HyperSyncOptions) {
    this.url = options.url ?? "https://robinhood.hypersync.xyz";
    this.token = options.bearerToken;
    this.rpc = options.rpcClient;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Unauthenticated, so it doubles as a support check. */
  async head(): Promise<bigint> {
    const response = await fetch(`${this.url}/height`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`HyperSync height failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { height?: number };
    if (typeof body.height !== "number") {
      throw new Error("HyperSync height response had no height");
    }
    return BigInt(body.height);
  }

  async blockHash(blockNumber: bigint): Promise<Hex> {
    const block = await this.rpc.getBlock({ blockNumber });
    return block.hash;
  }

  async getLogs(query: LogQuery): Promise<LogBatch> {
    const body: Record<string, unknown> = {
      // eslint-disable-next-line no-restricted-syntax -- block numbers for a JSON API; not money
      from_block: Number(query.fromBlock),
      // eslint-disable-next-line no-restricted-syntax -- block numbers for a JSON API; not money
      to_block: Number(query.toBlock) + 1, // HyperSync to_block is exclusive
      field_selection: {
        log: [
          "block_number",
          "block_hash",
          "transaction_hash",
          "log_index",
          "address",
          "data",
          "topic0",
          "topic1",
          "topic2",
          "topic3",
        ],
      },
    };

    // An empty address list means "any address", which is what the curve stream
    // needs once there are thousands of curves.
    body.logs =
      query.addresses.length > 0
        ? [{ address: query.addresses.map((a) => a.toLowerCase()) }]
        : [{}];

    const response = await fetch(`${this.url}/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 401) {
        throw new Error(
          "HyperSync rejected the token. Get a free one at " +
            "https://app.envio.dev/api-tokens and set HYPERSYNC_BEARER_TOKEN.",
        );
      }
      throw new Error(
        `HyperSync query failed: HTTP ${response.status} ${text.slice(0, 120)}`,
      );
    }

    const payload = (await response.json()) as HyperSyncResponse;
    const logs: RawLog[] = [];

    for (const page of payload.data ?? []) {
      for (const log of page.logs ?? []) {
        if (
          log.block_number === undefined ||
          log.transaction_hash === undefined ||
          log.log_index === undefined ||
          log.address === undefined ||
          log.block_hash === undefined
        ) {
          continue;
        }

        const topics = [log.topic0, log.topic1, log.topic2, log.topic3].filter(
          (topic): topic is string => typeof topic === "string" && topic.length > 0,
        ) as Hex[];

        if (query.topics0 !== undefined) {
          const topic0 = topics[0];
          if (topic0 === undefined || !query.topics0.includes(topic0)) continue;
        }

        logs.push({
          address: log.address as Address,
          topics,
          data: (log.data ?? "0x") as Hex,
          blockNumber: BigInt(log.block_number),
          blockHash: log.block_hash as Hex,
          transactionHash: log.transaction_hash as Hex,
          logIndex: log.log_index,
        });
      }
    }

    // next_block is the first block NOT covered, so the batch reached one below it.
    // Trusting the requested toBlock instead would silently skip blocks whenever
    // HyperSync paginates.
    const reached =
      // eslint-disable-next-line no-restricted-syntax -- comparing block numbers; not money
      payload.next_block !== undefined && payload.next_block > Number(query.fromBlock)
        ? BigInt(payload.next_block) - 1n
        : query.toBlock;

    return { logs, reachedBlock: reached < query.toBlock ? reached : query.toBlock };
  }
}
