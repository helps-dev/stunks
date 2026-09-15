/**
 * Compare log-source options for the indexer backfill.
 *
 *   pnpm probe:sources
 *
 * WHY THIS EXISTS
 *
 * Robinhood Chain produces ~852,912 blocks/day and the Pons V2 factory was deployed
 * 36.6M blocks before head. Free public RPC caps eth_getLogs at a few hundred blocks
 * and rate-limits to roughly 2 req/s, which puts a full backfill at 10+ hours of
 * pure RPC for a single address filter — before per-curve trade filters multiply it.
 *
 * So the backfill source is an architectural decision, not a detail. This script
 * measures the candidates instead of guessing.
 */

import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { getChainContracts, ROBINHOOD_CHAIN_ID, robinhoodChain } from "@stunks/config";

const FACTORY: Address = getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2Factory;
const FACTORY_DEPLOY_BLOCK =
  getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2FactoryDeployBlock;

const HYPERSYNC_URL = "https://robinhood.hypersync.xyz";

function section(title: string): void {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

/** Widest eth_getLogs window an endpoint actually tolerates. */
async function measureLogWindow(
  client: PublicClient,
  head: bigint,
): Promise<{ widest: bigint; rejectedAt: bigint | null }> {
  let widest = 0n;
  let rejectedAt: bigint | null = null;

  for (const span of [10n, 50n, 100n, 250n, 500n, 1_000n, 5_000n, 10_000n]) {
    try {
      await client.getLogs({
        address: FACTORY,
        fromBlock: head - span,
        toBlock: head,
      });
      widest = span;
    } catch {
      rejectedAt = span;
      break;
    }
    // Pace against ~2 req/s public limits.
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return { widest, rejectedAt };
}

async function probeRpc(label: string, url: string, head: bigint): Promise<void> {
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http(url, { retryCount: 1, timeout: 20_000 }),
  }) as PublicClient;

  try {
    const chainId = await client.getChainId();
    if (chainId !== ROBINHOOD_CHAIN_ID) {
      console.log(`  ${label.padEnd(12)} wrong chain (${chainId})`);
      return;
    }

    const { widest, rejectedAt } = await measureLogWindow(client, head);
    if (widest === 0n) {
      console.log(`  ${label.padEnd(12)} no window succeeded`);
      return;
    }

    const blocksToBackfill = head - FACTORY_DEPLOY_BLOCK;
    const calls = blocksToBackfill / widest;
    // At ~2 req/s, which is what free public endpoints tolerate.
    const hours = Number(calls) / 2 / 3600;

    console.log(
      `  ${label.padEnd(12)} widest window ${String(widest).padStart(5)} blocks` +
        `${rejectedAt !== null ? ` (rejected at ${rejectedAt})` : ""}`,
    );
    console.log(
      `  ${"".padEnd(12)} backfill = ${calls.toLocaleString("en-US")} calls ` +
        `≈ ${hours.toFixed(1)} h at 2 req/s`,
    );
  } catch (error) {
    console.log(
      `  ${label.padEnd(12)} unreachable: ${
        error instanceof Error ? error.message.slice(0, 60) : String(error)
      }`,
    );
  }
}

async function probeHyperSync(head: bigint): Promise<void> {
  // The height endpoint is unauthenticated, so support can be confirmed without a
  // token. That alone answers whether this chain is covered at all.
  try {
    const response = await fetch(`${HYPERSYNC_URL}/height`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.log(`  height check failed: HTTP ${response.status}`);
      return;
    }
    const body = (await response.json()) as { height?: number };
    const height = body.height ?? 0;
    console.log(`  SUPPORTED — height ${height.toLocaleString("en-US")}`);

    // Within a few thousand blocks of head means it is genuinely tracking this
    // chain rather than serving a stale or unrelated dataset.
    const lag = head - BigInt(height);
    const tracking = lag < 100_000n && lag > -100_000n;
    console.log(
      `  ${tracking ? "tracking chain head" : "NOT tracking head"} (rpc head ${head}, lag ${lag})`,
    );
  } catch (error) {
    console.log(
      `  unreachable: ${error instanceof Error ? error.message.slice(0, 70) : String(error)}`,
    );
    return;
  }

  // A query needs a token. Report whether one is configured rather than failing.
  const token = process.env.HYPERSYNC_BEARER_TOKEN;
  if (!token) {
    console.log("  query auth: no HYPERSYNC_BEARER_TOKEN set");
    console.log("             free token: https://app.envio.dev/api-tokens");
    return;
  }

  try {
    const started = Date.now();
    const response = await fetch(`${HYPERSYNC_URL}/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        // A million blocks in one request — the whole point of HyperSync.
        from_block: Number(FACTORY_DEPLOY_BLOCK),
        to_block: Number(FACTORY_DEPLOY_BLOCK + 1_000_000n),
        logs: [{ address: [FACTORY] }],
        field_selection: {
          log: ["block_number", "transaction_hash", "log_index", "topic0", "data"],
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      console.log(
        `  query: HTTP ${response.status} ${(await response.text()).slice(0, 90)}`,
      );
      return;
    }

    const body = (await response.json()) as {
      data?: { logs?: unknown[] }[];
      next_block?: number;
    };
    const logs = (body.data ?? []).reduce(
      (total, page) => total + (page.logs?.length ?? 0),
      0,
    );
    const elapsed = Date.now() - started;
    const scanned = (body.next_block ?? 0) - Number(FACTORY_DEPLOY_BLOCK);

    console.log(
      `  query: ok — ${scanned.toLocaleString("en-US")} blocks scanned, ` +
        `${logs} logs, ${elapsed} ms`,
    );
    if (scanned > 0) {
      const total = Number(head - FACTORY_DEPLOY_BLOCK);
      const estimateMinutes = ((total / scanned) * elapsed) / 1000 / 60;
      console.log(
        `  full backfill estimate ≈ ${estimateMinutes.toFixed(1)} minutes ` +
          `(vs 10+ hours on free RPC)`,
      );
    }
  } catch (error) {
    console.log(
      `  query failed: ${error instanceof Error ? error.message.slice(0, 70) : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  const primary =
    (process.env.RPC_ENDPOINTS ?? "https://robinhood.drpc.org").split(",")[0]?.trim() ??
    "https://robinhood.drpc.org";

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http(primary, { retryCount: 2, timeout: 20_000 }),
  }) as PublicClient;

  const head = await client.getBlockNumber();

  console.log("STUNKS.FUN — indexer log-source comparison");
  console.log(`  head block            ${head.toLocaleString("en-US")}`);
  console.log(`  factory deploy block  ${FACTORY_DEPLOY_BLOCK.toLocaleString("en-US")}`);
  console.log(
    `  blocks to backfill    ${(head - FACTORY_DEPLOY_BLOCK).toLocaleString("en-US")}`,
  );

  section("1. RPC endpoints (fine for live tailing, painful for backfill)");
  for (const [label, url] of [
    ["drpc", "https://robinhood.drpc.org"],
    ["ordofi", "https://rpc.ordofi.network"],
  ] as const) {
    await probeRpc(label, url, head);
  }

  section("2. Envio HyperSync");
  await probeHyperSync(head);

  section("Conclusion");
  console.log(
    "  Live tailing: RPC is comfortable. ~10 blocks/sec is a small window per tick.\n" +
      "  Backfill:     RPC is not viable. Use HyperSync (free token) or a paid archive\n" +
      "                RPC with wide eth_getLogs support.\n\n" +
      "  The indexer treats the log source as pluggable for exactly this reason, so the\n" +
      "  choice is configuration rather than a rewrite.",
  );
}

main().catch((error: unknown) => {
  console.error("Probe failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
