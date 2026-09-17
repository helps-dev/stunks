import { createServer, type Server } from "node:http";
import type { Repositories } from "@stunks/database";
import type { RpcPool } from "@stunks/web3";
import { BLOCK_TIME_SECONDS } from "@stunks/config";

/**
 * Indexer health.
 *
 * Reports lag in blocks AND in seconds, because on this chain those are wildly
 * different intuitions: 10,000 blocks sounds alarming but is about 17 minutes at
 * ~101 ms per block. Reporting only blocks would make normal operation look broken.
 *
 * Readiness deliberately does not fail on lag alone. A backfill legitimately runs
 * millions of blocks behind for its entire duration, and a probe that kills the
 * process for that would make backfilling impossible.
 */

export interface HealthSnapshot {
  readonly status: "ok" | "degraded";
  readonly chainId: number;
  readonly chainHead: string | null;
  readonly streams: {
    stream: string;
    indexedBlock: string;
    lagBlocks: string | null;
    lagSeconds: number | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    isPaused: boolean;
    logWindowSize: number;
    /**
     * Blocks between the configured start block and this checkpoint that the index
     * does not cover. Null when the checkpoint is at or below the start.
     */
    unscannedBelow: string | null;
  }[];
  readonly unresolvedFailedBlocks: number;
  /**
   * True when a stream's checkpoint sits above the configured start block, so the
   * range in between is not covered by the index.
   *
   * This is not lag. Lag catches up; a gap below the checkpoint never does, because
   * `advance` only ever moves forward.
   */
  readonly hasUnscannedHistory: boolean;
  readonly rpc: {
    url: string;
    healthy: boolean;
    avgLatencyMs: number | null;
    totalFailures: number;
    lastErrorKind: string | null;
  }[];
  readonly checkedAt: string;
}

export interface HealthDeps {
  readonly chainId: number;
  readonly repos: Repositories;
  readonly pool: RpcPool;
  readonly chainHead: () => Promise<bigint>;
  /**
   * The block the indexer is configured to start from.
   *
   * Reported because it is NOT enforced after first run. `getOrCreate` writes it only
   * when the checkpoint row is absent and ignores it forever after, so a checkpoint
   * created once at the wrong height stays wrong and INDEXER_START_BLOCK silently
   * stops meaning anything.
   *
   * Observed on 2026-09-17: configured start 26,841,846, factory checkpoint
   * 65,231,377, earliest indexed launch 63,775,021 — and TokenLaunched events exist
   * on-chain down to at least block 40,000,000. Roughly 37M blocks of launch history
   * were never scanned, while this endpoint reported `ok`.
   */
  readonly startBlock: bigint;
}

export async function buildHealthSnapshot(deps: HealthDeps): Promise<HealthSnapshot> {
  let chainHead: bigint | null = null;
  try {
    chainHead = await deps.chainHead();
  } catch {
    chainHead = null;
  }

  const { streams, unresolvedFailedBlocks } = await deps.repos.checkpoints.health(
    deps.chainId,
  );

  const streamReports = streams.map((state) => {
    const lagBlocks = chainHead === null ? null : chainHead - state.lastProcessedBlock;
    // A gap BELOW the checkpoint, which is a different thing from being behind the
    // head. Nothing in the indexer will ever go back for it.
    const unscannedBelow =
      state.lastProcessedBlock > deps.startBlock
        ? state.lastProcessedBlock - deps.startBlock
        : null;
    return {
      stream: state.stream,
      indexedBlock: state.lastProcessedBlock.toString(),
      lagBlocks: lagBlocks === null ? null : lagBlocks.toString(),
      lagSeconds:
        lagBlocks === null
          ? null
          : // eslint-disable-next-line no-restricted-syntax -- block counts are not money; this is a human-readable lag estimate
            Math.round(Number(lagBlocks) * BLOCK_TIME_SECONDS),
      lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
      lastError: state.lastError,
      isPaused: state.isPaused,
      logWindowSize: state.logWindowSize,
      unscannedBelow: unscannedBelow?.toString() ?? null,
    };
  });

  // Only meaningful for a stream that legitimately starts at the configured block.
  // The curve stream is fast-forwarded past provably empty history on purpose, so it
  // is excluded rather than reported as a permanent gap.
  const hasUnscannedHistory = streamReports.some(
    (report) => report.stream === "factory" && report.unscannedBelow !== null,
  );

  // Degraded means something needs attention, not simply that a backfill is behind.
  const degraded =
    chainHead === null ||
    unresolvedFailedBlocks > 0 ||
    // An incomplete index is not healthy, however current its head is. Reporting `ok`
    // over a 37M-block hole is the same failure as reporting freshness from the
    // fastest stream: technically about something real, and materially misleading.
    hasUnscannedHistory ||
    streamReports.some((report) => report.isPaused || report.lastError !== null);

  return {
    status: degraded ? "degraded" : "ok",
    chainId: deps.chainId,
    chainHead: chainHead?.toString() ?? null,
    streams: streamReports,
    unresolvedFailedBlocks,
    hasUnscannedHistory,
    rpc: deps.pool.stats().map((endpoint) => ({
      url: endpoint.url,
      healthy: endpoint.healthy,
      avgLatencyMs:
        endpoint.avgLatencyMs === null ? null : Math.round(endpoint.avgLatencyMs),
      totalFailures: endpoint.totalFailures,
      lastErrorKind: endpoint.lastErrorKind,
    })),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Interface the health server binds to.
 *
 * Loopback by default, and that default is load-bearing. This endpoint reports
 * checkpoints, RPC endpoint URLs and failure counts with no authentication in front of
 * it, so it is an internal operational view and nothing else.
 *
 * `server.listen(port)` with no host binds every interface. Under Docker that was
 * masked by a `127.0.0.1:9464:9464` port mapping, but the systemd unit has no such
 * mapping — it only sets HEALTH_PORT — so on that path the endpoint was reachable on
 * the VPS's public IP. Setting a port never restricted a binding; only a host does.
 *
 * HEALTH_HOST exists for the one legitimate exception: a container that must be probed
 * from outside its own network namespace. Anything reachable beyond loopback needs
 * something in front of it.
 */
const DEFAULT_HEALTH_HOST = "127.0.0.1";

/**
 * Minimal health server. No framework: the indexer is a worker, and one endpoint is
 * not a reason to take on a web dependency.
 */
export function startHealthServer(
  port: number,
  deps: HealthDeps,
  host: string = DEFAULT_HEALTH_HOST,
): Server {
  const server = createServer((request, response) => {
    if (request.url !== "/health" && request.url !== "/") {
      response.writeHead(404).end();
      return;
    }

    void buildHealthSnapshot(deps)
      .then((snapshot) => {
        response.writeHead(snapshot.status === "ok" ? 200 : 503, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(snapshot, null, 2));
      })
      .catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  });

  server.listen(port, host);
  return server;
}
