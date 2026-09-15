import type { Address, PublicClient } from "viem";
import { createIndexerClient } from "@stunks/web3";
import { createRepositories, getPrisma, waitForDatabase } from "@stunks/database";
import { STREAMS, loadIndexerConfig } from "./config.js";
import { Scanner, type ScanTickResult } from "./scanner.js";
import { RpcLogSource } from "./sources/rpc.js";
import { HyperSyncLogSource } from "./sources/hypersync.js";
import type { LogSource } from "./sources/types.js";
import { processFactoryLogs } from "./processors/factory.js";
import { processCurveLogs } from "./processors/curve.js";
import { startHealthServer } from "./health.js";
import { BlockTimeCache } from "./block-cache.js";

/**
 * Indexer entry point.
 *
 * Two streams, deliberately separate because their shapes differ:
 *
 *   factory  one fixed address, low log volume, must run AHEAD of curves so that a
 *            trade always has a token to attach to
 *   curves   one contract per launch, so the address set grows continuously and is
 *            re-read from the database every tick
 *
 * Backfill and tailing use different sources. Measured: RPC backfill of 36.8M blocks
 * is ~51 hours at a 100-block window, while HyperSync answers millions of blocks per
 * query. Tailing over RPC is trivial by comparison.
 */

function log(message: string, meta?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    msg: message,
    ...(meta ?? {}),
  };
  console.log(JSON.stringify(line));
}

function formatTick(stream: string, result: ScanTickResult): void {
  if (result.scanned === 0n && result.logs === 0) return;
  log("scanned", {
    stream,
    from: result.fromBlock.toString(),
    to: result.toBlock.toString(),
    blocks: result.scanned.toString(),
    logs: result.logs,
    caughtUp: result.caughtUp,
  });
}

async function main(): Promise<void> {
  const config = loadIndexerConfig();
  const prisma = getPrisma();

  // A serverless Postgres suspends when idle and refuses the first connection after
  // waking. Crashing on that would make the indexer unrunnable without a supervisor.
  await waitForDatabase(prisma, {
    onAttempt: (attempt, total, error) =>
      log("waiting for database", { attempt, total, error }),
  });

  const repos = createRepositories(prisma);

  const { client, pool, assertChain } = createIndexerClient(config.RPC_ENDPOINTS);
  // Refuse to index the wrong chain. Everything downstream is keyed by chainId, so a
  // mismatch would quietly mix two histories in one database.
  await assertChain();

  const rpcSource = new RpcLogSource(client as PublicClient, config.LOG_WINDOW);
  // Multicall batches the contract reads; this removes the per-log block lookups
  // that multicall cannot help with.
  const blockTimes = new BlockTimeCache(client as PublicClient);

  const backfillSource: LogSource =
    config.BACKFILL_SOURCE === "hypersync"
      ? new HyperSyncLogSource({
          url: config.HYPERSYNC_URL,
          // Presence is validated in loadIndexerConfig.
          bearerToken: config.HYPERSYNC_BEARER_TOKEN as string,
          rpcClient: client as PublicClient,
        })
      : rpcSource;

  const head = await rpcSource.head();
  log("indexer starting", {
    chainId: config.CHAIN_ID,
    factory: config.factory,
    startBlock: config.startBlock.toString(),
    head: head.toString(),
    blocksBehind: (head - config.startBlock).toString(),
    backfillSource: backfillSource.name,
    confirmationDepth: config.CONFIRMATION_DEPTH,
  });

  if (config.BACKFILL_SOURCE === "rpc" && head - config.startBlock > 100_000n) {
    log("WARNING: backfilling over RPC", {
      blocksBehind: (head - config.startBlock).toString(),
      note:
        "Measured at roughly 51 hours for a full backfill at a 100-block window. " +
        "Set BACKFILL_SOURCE=hypersync with a free token from app.envio.dev/api-tokens.",
    });
  }

  const healthServer = startHealthServer(config.HEALTH_PORT, {
    chainId: config.CHAIN_ID,
    repos,
    pool,
    chainHead: () => rpcSource.head(),
  });
  log("health endpoint listening", { port: config.HEALTH_PORT, path: "/health" });

  const factoryAddresses = async (): Promise<readonly Address[]> => [config.factory];
  const curveAddresses = async (): Promise<readonly Address[]> =>
    (await repos.tokens.listActiveCurves(config.CHAIN_ID)) as Address[];

  const makeFactoryScanner = (source: LogSource) =>
    new Scanner({
      name: "factory",
      stream: STREAMS.factory,
      chainId: config.CHAIN_ID,
      client: client as PublicClient,
      source,
      repos,
      startBlock: config.startBlock,
      confirmationDepth: config.CONFIRMATION_DEPTH,
      addresses: factoryAddresses,
      log,
      process: async (logs) => {
        const result = await processFactoryLogs(logs, {
          client: client as PublicClient,
          repos,
          chainId: config.CHAIN_ID,
          factory: config.factory,
          blockTimes,
          log,
        });
        if (result.launches > 0 || result.phaseUpdates > 0) {
          log("factory batch", {
            launches: result.launches,
            phaseUpdates: result.phaseUpdates,
          });
        }
      },
    });

  const makeCurveScanner = (source: LogSource) =>
    new Scanner({
      name: "curves",
      stream: STREAMS.curves,
      chainId: config.CHAIN_ID,
      client: client as PublicClient,
      source,
      repos,
      startBlock: config.startBlock,
      confirmationDepth: config.CONFIRMATION_DEPTH,
      addresses: curveAddresses,
      // Without any known curve there is nothing to filter on, and an unfiltered
      // query would pull every log on the chain.
      requireAddresses: true,
      // Never scan past the factory: a trade needs its token to be indexed first.
      maxBlock: async () => {
        const state = await repos.checkpoints.getOrCreate(
          config.CHAIN_ID,
          STREAMS.factory,
          config.startBlock,
        );
        return state.lastProcessedBlock;
      },
      log,
      process: async (logs) => {
        const result = await processCurveLogs(logs, {
          client: client as PublicClient,
          repos,
          chainId: config.CHAIN_ID,
          blockTimes,
          log,
        });
        if (result.trades > 0 || result.unmatched > 0) {
          log("curve batch", {
            trades: result.trades,
            duplicates: result.duplicates,
            unmatched: result.unmatched,
            tokensTouched: result.tokensTouched,
          });
        }
      },
    });

  const scanners = [makeFactoryScanner(backfillSource), makeCurveScanner(backfillSource)];

  const shutdown = () => {
    log("shutting down");
    for (const scanner of scanners) scanner.stop();
    healthServer.close();
    void prisma.$disconnect().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Both streams run CONCURRENTLY, with the curve stream capped at the factory
  // checkpoint rather than waiting for the factory to finish.
  //
  // An earlier version ran factory-to-completion first, which deadlocked: the
  // indexer moves slower than the chain head, so the factory backfill never
  // completed and the curve stream never started. The observable result was 716
  // tokens indexed and zero trades.
  //
  // Capping instead of sequencing preserves the actual requirement — a trade needs
  // its token to exist first — without requiring the factory to ever be "done".
  log("scanning both streams concurrently", {
    intervalMs: config.TAIL_INTERVAL_MS,
    note: "curve stream is capped at the factory checkpoint",
  });

  if (config.backfillOnly) {
    // Run until both streams reach the confirmed head, then stop.
    let factoryDone = false;
    let curvesDone = false;
    await Promise.all([
      scanners[0]!.backfill((result) => {
        formatTick("factory", result);
        factoryDone = result.caughtUp;
      }),
      (async () => {
        // The curve stream cannot finish before the factory does, since its ceiling
        // follows the factory checkpoint.
        while (!curvesDone) {
          const result = await scanners[1]!.tick();
          formatTick("curves", result);
          if (result.caughtUp && factoryDone) curvesDone = true;
          if (result.scanned === 0n) await new Promise((r) => setTimeout(r, 500));
        }
      })(),
    ]);

    log("backfill complete");
    healthServer.close();
    await prisma.$disconnect();
    return;
  }

  await Promise.all([
    scanners[0]!.tail(config.TAIL_INTERVAL_MS, (r) => formatTick("factory", r)),
    scanners[1]!.tail(config.TAIL_INTERVAL_MS, (r) => formatTick("curves", r)),
  ]);
}

main().catch((error: unknown) => {
  log("indexer failed", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
});
