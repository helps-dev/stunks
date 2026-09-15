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
  }[];
  readonly unresolvedFailedBlocks: number;
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
    };
  });

  // Degraded means something needs attention, not simply that a backfill is behind.
  const degraded =
    chainHead === null ||
    unresolvedFailedBlocks > 0 ||
    streamReports.some((report) => report.isPaused || report.lastError !== null);

  return {
    status: degraded ? "degraded" : "ok",
    chainId: deps.chainId,
    chainHead: chainHead?.toString() ?? null,
    streams: streamReports,
    unresolvedFailedBlocks,
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
 * Minimal health server. No framework: the indexer is a worker, and one endpoint is
 * not a reason to take on a web dependency.
 */
export function startHealthServer(port: number, deps: HealthDeps): Server {
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

  server.listen(port);
  return server;
}
