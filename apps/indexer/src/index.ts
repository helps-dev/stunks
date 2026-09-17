import type { Address, Hex, PublicClient } from "viem";
import { numberToHex } from "viem";
import { createIndexerClient } from "@stunks/web3";
import { CURVE_TOPICS, FACTORY_TOPICS } from "@stunks/pons";
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

  /**
   * One log source per stream, so each discovers its own safe window.
   *
   * These two queries are not comparable in size. The factory filters on a single
   * address and a 2,914-block scan came back as 20 KB. The curve stream filters on
   * event signature across every curve on the chain, where 500 blocks is already
   * 566 KB and 2,914 blocks does not return at all. Sharing one AdaptiveLogWindow
   * meant the factory's cheap successes kept widening the window that the curve
   * stream then choked on, and a curve rejection kept shrinking the factory's.
   */
  // The pool is passed so `eth_getLogs` is sent with the topic filter actually
  // intended. viem's `getLogs` drops a raw `topics` array and puts `"topics": []` on
  // the wire, which a node reads as "no filter" — measured at 4,097 logs returned
  // where 63 were wanted. See the note on RpcLogSource.
  const factorySource = new RpcLogSource(client as PublicClient, config.LOG_WINDOW, pool);
  const curveSource = new RpcLogSource(client as PublicClient, config.LOG_WINDOW, pool);
  // Multicall batches the contract reads; this removes the per-log block lookups
  // that multicall cannot help with. `eth_getBlockByNumber` is not a contract call, so
  // it goes through the pool's JSON-RPC batching instead — one POST per 100 blocks
  // rather than one per block, which is what stopped the wide-window bursts from
  // saturating the endpoints.
  const blockTimes = new BlockTimeCache(client as PublicClient, {
    log,
    readBatch: async (blockNumbers) => {
      const blocks = await pool.requestBatch<{ timestamp: Hex }>(
        blockNumbers.map((blockNumber) => ({
          method: "eth_getBlockByNumber",
          params: [numberToHex(blockNumber), false],
        })),
      );
      return blocks.map((block) => BigInt(block.timestamp));
    },
  });

  const hyperSyncSource =
    config.BACKFILL_SOURCE === "hypersync"
      ? new HyperSyncLogSource({
          url: config.HYPERSYNC_URL,
          // Presence is validated in loadIndexerConfig.
          bearerToken: config.HYPERSYNC_BEARER_TOKEN as string,
          rpcClient: client as PublicClient,
        })
      : null;

  const factoryLogSource: LogSource = hyperSyncSource ?? factorySource;
  const curveLogSource: LogSource = hyperSyncSource ?? curveSource;

  const head = await factorySource.head();
  log("indexer starting", {
    chainId: config.CHAIN_ID,
    factory: config.factory,
    startBlock: config.startBlock.toString(),
    head: head.toString(),
    blocksBehind: (head - config.startBlock).toString(),
    backfillSource: factoryLogSource.name,
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

  const healthServer = startHealthServer(
    config.HEALTH_PORT,
    {
      chainId: config.CHAIN_ID,
      repos,
      pool,
      chainHead: () => factorySource.head(),
    },
    config.HEALTH_HOST,
  );
  log("health endpoint listening", {
    host: config.HEALTH_HOST,
    port: config.HEALTH_PORT,
    path: "/health",
    // Loud on purpose: this endpoint has no authentication in front of it.
    note:
      config.HEALTH_HOST === "127.0.0.1"
        ? undefined
        : "bound beyond loopback — this endpoint is unauthenticated",
  });

  const factoryAddresses = async (): Promise<readonly Address[]> => [config.factory];
  /**
   * The curve stream filters on event signature only, with no address selectors.
   *
   * Listing every active curve looked more precise, but it does not scale and it was
   * measured as the reason the stream stalled. Providers cap a getLogs call at 1,000
   * address selectors, so 14,123 active curves became 15 requests for every single
   * tick — and each one retries three times across two endpoints when the free
   * endpoints throttle, so one tick could cost ~90 calls. The stream went six minutes
   * without advancing a block while the factory stream kept moving. That cost also
   * grows with every launch, so it gets worse over time rather than better.
   *
   * Dropping the address filter makes it exactly one request per tick, permanently.
   * It is safe because the address list was never what resolved a log to a token:
   * `processCurveLogs` maps each log through `findManyByCurves` on the addresses the
   * logs themselves carry, counts anything unresolved as `unmatched`, and skips it.
   * The seven topic0 values are Pons curve signatures, so the node still does the
   * filtering — this widens the filter from "these curves" to "any Pons curve",
   * which now also covers graduated curves that `listActiveCurves` excluded.
   */
  const curveAddresses = async (): Promise<readonly Address[]> => [];
  // Filter at the node, not after downloading every ERC-20 Transfer and unrelated
  // curve event. The maps are constructed from verified ABI selectors, so this cannot
  // omit a Pons event the processors understand.
  const factoryTopics = Object.keys(FACTORY_TOPICS) as Hex[];
  const curveTopics = Object.keys(CURVE_TOPICS) as Hex[];

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
      topics0: factoryTopics,
      // The factory stream owns tokens (and the creators attached to them). Trades go
      // with them through the `onDelete: Cascade` on Trade.token, so they are not
      // deleted separately here — a token that never launched cannot have traded.
      deleteAbove: async (rollbackTo) => ({
        tokens: await repos.tokens.deleteAboveBlock(config.CHAIN_ID, rollbackTo),
      }),
      // Removing those tokens invalidates any trade the curve stream already indexed
      // for them, so the curve stream cannot be left claiming those blocks are done.
      cascadeStreams: [STREAMS.curves],
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
      topics0: curveTopics,
      // The guard this replaces existed because an empty address list used to mean an
      // unfiltered query. It does not: `topics0` is always sent, so the node still
      // returns only Pons curve events, and the volume stays bounded by the block
      // window rather than by how many curves exist.
      requireAddresses: false,
      // The curve stream owns trades and nothing else. It must NOT delete tokens: it
      // runs far behind the factory by design, so a chain-scoped token delete here
      // would erase launches the factory had already indexed and never re-scans.
      deleteAbove: async (rollbackTo) => ({
        trades: await repos.trades.deleteAboveBlock(config.CHAIN_ID, rollbackTo),
      }),
      // Never scan past the factory: a trade needs its token to be indexed first.
      // Nothing else happens here — an earlier version also fast-forwarded the curve
      // checkpoint from inside this callback, which ran on every tick and could ask
      // `advance` to move backwards once the curve stream had overtaken the value.
      // Skipping empty history is a startup concern, handled once below.
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
          factory: config.factory,
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

  const scanners = [
    makeFactoryScanner(factoryLogSource),
    makeCurveScanner(curveLogSource),
  ];

  // Skip the stretch of history before any curve existed. A curve cannot emit a trade
  // before it is deployed, so those blocks are provably empty for this stream — and
  // scanning them was measured at ~44 hours of finding nothing. Done once, at startup,
  // and it only ever moves the checkpoint forward.
  {
    await repos.checkpoints.getOrCreate(
      config.CHAIN_ID,
      STREAMS.curves,
      config.startBlock,
    );
    const earliest = await repos.tokens.earliestLaunchBlock(config.CHAIN_ID);
    if (earliest !== null && earliest > 0n) {
      const moved = await repos.checkpoints.fastForward({
        chainId: config.CHAIN_ID,
        stream: STREAMS.curves,
        toBlock: earliest - 1n,
        reason: "no curve existed before the earliest indexed launch",
      });
      if (moved && moved.lastProcessedBlock === earliest - 1n) {
        log("curve stream fast-forwarded past empty history", {
          toBlock: (earliest - 1n).toString(),
        });
      }
    }
  }

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

  // Both streams draw on one pool of free RPC endpoints, and that pool is the binding
  // constraint: with each stream polling every TAIL_INTERVAL_MS, dRPC returned
  // RATE_LIMITED and OrdoFi UPSTREAM_UNAVAILABLE, and the curve stream made no
  // progress at all for six minutes while the factory — already at the head — kept
  // spending the budget on ticks that found 0-5 logs.
  //
  // The curve stream is capped at the factory checkpoint, so whenever the factory sits
  // far ahead, the curve stream already has all the runway it can use and the factory
  // gains nothing by polling hard. Back the factory off in that case and the freed
  // requests go to the stream that is actually behind. The gap is measured against one
  // observed curve scan (4,554 blocks), so this threshold leaves roughly ten such
  // scans of headroom before the factory speeds up again.
  const FACTORY_SLACK_BLOCKS = 50_000n;
  const FACTORY_BACKOFF_MULTIPLIER = 10;
  /**
   * How close to the head counts as "the factory has runway to spare".
   *
   * `caughtUp` means the factory reached the confirmed head EXACTLY on its last tick,
   * and under RPC pressure that is almost never true — a tick that fails, narrows or
   * lands a few hundred blocks short reports false. Measured on 2026-09-17: the
   * factory sat 831 blocks behind (~84 seconds) while the curve stream was 899,726
   * blocks behind (~25 hours), and because 831 > 0 the factory never yielded any
   * budget to the stream that actually needed it.
   *
   * So the test is absolute, not exact — but it also has to stay tight, because the
   * factory settles wherever this threshold puts it. This IS the delay before a new
   * launch appears on the site, and on a launchpad that delay is the product. 2,000
   * blocks is about three and a half minutes: loose enough that a factory a few
   * hundred blocks back still yields budget, tight enough that a launch is never
   * more than a few minutes old, and a factory genuinely falling behind still
   * cancels its own backoff — the property the previous fix existed to preserve.
   */
  const FACTORY_NEAR_HEAD_BLOCKS = 2_000n;
  let factoryBlock = 0n;
  let curveBlock = 0n;
  let factoryAtHead = false;
  let factoryLag: bigint | null = null;
  let backedOff = false;

  const factoryInterval = (): number => {
    const slack = factoryBlock - curveBlock;
    // Only ever slow down a factory stream that is actually at the head. Gating on the
    // curve gap alone was wrong and it caused a six-hour outage: the gap stays above
    // any threshold for as long as the curve backlog lasts, so once RPC trouble pushed
    // the factory off the head it stayed throttled to a tenth of its rate and lost
    // ground to chain production without bound, ending 212,551 blocks behind. Falling
    // behind the head now cancels the backoff by itself.
    // Near the head, not necessarily exactly at it. See FACTORY_NEAR_HEAD_BLOCKS.
    const factoryNearHead =
      factoryAtHead || (factoryLag !== null && factoryLag <= FACTORY_NEAR_HEAD_BLOCKS);
    const shouldBackOff = factoryNearHead && slack > FACTORY_SLACK_BLOCKS;
    if (shouldBackOff !== backedOff) {
      backedOff = shouldBackOff;
      log(
        shouldBackOff
          ? "factory tail backing off so the curve stream gets the RPC budget"
          : "curve stream caught up; factory tail back to full speed",
        {
          factoryBlock: factoryBlock.toString(),
          curveBlock: curveBlock.toString(),
          slackBlocks: slack.toString(),
          factoryAtHead,
          factoryLagBlocks: factoryLag?.toString() ?? null,
          intervalMs: shouldBackOff
            ? config.TAIL_INTERVAL_MS * FACTORY_BACKOFF_MULTIPLIER
            : config.TAIL_INTERVAL_MS,
        },
      );
    }
    return shouldBackOff
      ? config.TAIL_INTERVAL_MS * FACTORY_BACKOFF_MULTIPLIER
      : config.TAIL_INTERVAL_MS;
  };

  await Promise.all([
    scanners[0]!.tail(factoryInterval, (r) => {
      // `toBlock` is the checkpoint this tick reached, which is what the curve stream
      // is capped by. A failed tick reports the retained checkpoint, so the gap stays
      // truthful when the source is unavailable.
      factoryBlock = r.toBlock;
      factoryAtHead = r.caughtUp;
      // Only when the head was actually read. A tick that could not reach the source
      // says nothing about the distance to the head, so the previous measurement is
      // the best available answer and is kept rather than being reset to "unknown".
      if (r.confirmedHead !== null) {
        factoryLag = r.confirmedHead > r.toBlock ? r.confirmedHead - r.toBlock : 0n;
      }
      formatTick("factory", r);
    }),
    scanners[1]!.tail(config.TAIL_INTERVAL_MS, (r) => {
      curveBlock = r.toBlock;
      formatTick("curves", r);
    }),
  ]);
}

main().catch((error: unknown) => {
  log("indexer failed", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
});
