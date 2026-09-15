import { z } from "zod";
import {
  KNOWN_RPC_ENDPOINTS,
  ROBINHOOD_CHAIN_ID,
  getChainContracts,
} from "@stunks/config";
import { DEFAULT_CONFIRMATION_DEPTH } from "./reorg.js";

/**
 * Indexer configuration.
 *
 * The backfill source is a deliberate, explicit choice rather than a silent default,
 * because the measurement is stark:
 *
 *   RPC        100-block windows, ~2 req/s  -> ~51 hours for 36.8M blocks
 *   HyperSync  millions of blocks per query -> minutes
 *
 * So `BACKFILL_SOURCE=rpc` is allowed but has to be asked for.
 */

const endpointList = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

export const indexerEnvSchema = z.object({
  CHAIN_ID: z.coerce.number().int().default(ROBINHOOD_CHAIN_ID),

  /**
   * Endpoints for log scanning and block reads.
   *
   * Note: rpc.ordofi.network is fine for eth_call but was measured as unusable for
   * eth_getLogs, so it must not be the only entry here.
   */
  RPC_ENDPOINTS: endpointList.default(
    `${KNOWN_RPC_ENDPOINTS.drpc},${KNOWN_RPC_ENDPOINTS.ordofi}`,
  ),

  INDEXER_START_BLOCK: z.coerce.bigint().nonnegative().optional(),

  /** `hypersync` needs HYPERSYNC_BEARER_TOKEN. `rpc` is viable only for live tailing. */
  BACKFILL_SOURCE: z.enum(["hypersync", "rpc"]).default("rpc"),
  HYPERSYNC_URL: z.string().url().default("https://robinhood.hypersync.xyz"),
  HYPERSYNC_BEARER_TOKEN: z.string().optional(),

  CONFIRMATION_DEPTH: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_CONFIRMATION_DEPTH),

  /** Initial eth_getLogs window. Adapts at runtime and is persisted per stream. */
  LOG_WINDOW: z.coerce.bigint().positive().default(100n),

  /** Pause between live-tail ticks. ~10 blocks at this chain's 101 ms block time. */
  TAIL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),

  /** Stop after backfill instead of tailing. Useful for a one-shot catch-up. */
  BACKFILL_ONLY: z.enum(["0", "1"]).default("0"),

  HEALTH_PORT: z.coerce.number().int().positive().default(9464),
});

export type IndexerEnv = z.infer<typeof indexerEnvSchema>;

export interface IndexerConfig extends IndexerEnv {
  readonly factory: `0x${string}`;
  readonly startBlock: bigint;
  readonly backfillOnly: boolean;
}

export function loadIndexerConfig(
  source: NodeJS.ProcessEnv = process.env,
): IndexerConfig {
  const parsed = indexerEnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid indexer configuration.\n${details}`);
  }
  const env = parsed.data;

  if (env.BACKFILL_SOURCE === "hypersync" && !env.HYPERSYNC_BEARER_TOKEN) {
    throw new Error(
      "BACKFILL_SOURCE=hypersync requires HYPERSYNC_BEARER_TOKEN. Get a free token at " +
        "https://app.envio.dev/api-tokens, or set BACKFILL_SOURCE=rpc — but note that " +
        "backfilling 36.8M blocks over RPC was measured at roughly 51 hours.",
    );
  }

  const contracts = getChainContracts(env.CHAIN_ID);

  return {
    ...env,
    factory: contracts.ponsV2Factory,
    // Default to the factory's deploy block, never genesis: starting at zero would
    // scan 26.8M blocks that cannot contain a Pons event.
    startBlock: env.INDEXER_START_BLOCK ?? contracts.ponsV2FactoryDeployBlock,
    backfillOnly: env.BACKFILL_ONLY === "1",
  };
}

/** Stream names, matching the `stream` column on IndexerState. */
export const STREAMS = {
  factory: "factory",
  curves: "curves",
} as const;
