import { z } from "zod";
import { isAddress } from "viem";
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

  /**
   * Interface the health endpoint binds to. Loopback unless deliberately widened.
   *
   * Docker needs `0.0.0.0` to be probed from the host, and the compose file supplies
   * it alongside a `127.0.0.1:` port mapping that keeps it off the internet. Outside a
   * container, widening this exposes an unauthenticated operational view.
   */
  HEALTH_HOST: z.string().min(1).default("127.0.0.1"),

  /**
   * Optional override for the factory address.
   *
   * It exists so that all three entry points agree. The web app reads
   * NEXT_PUBLIC_PONS_V2_FACTORY, `verify-pons` reads PONS_V2_FACTORY, and the indexer
   * used to read neither — it took the compiled-in address and silently ignored what
   * the environment said. A deployment that pointed the app at one factory and the
   * indexer at another would have looked configured and indexed the wrong protocol.
   *
   * Supplying it is checked, not merely accepted: see below.
   */
  PONS_V2_FACTORY: z
    .string()
    .refine((value) => isAddress(value), { message: "must be a valid EVM address" })
    .optional(),
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

  /**
   * Refuse a factory the code was not built against, rather than quietly following it.
   *
   * The compiled-in address is not a default to be overridden casually: the deploy
   * block, the verified ABIs and every fact in docs/PONS_V2_INTEGRATION.md were
   * established against that specific deployment. Indexing a different factory with
   * this address book would produce confident, wrong data — so a mismatch is a
   * configuration error to be reported, not a preference to be honoured.
   */
  if (
    env.PONS_V2_FACTORY !== undefined &&
    env.PONS_V2_FACTORY.toLowerCase() !== contracts.ponsV2Factory.toLowerCase()
  ) {
    throw new Error(
      `PONS_V2_FACTORY is ${env.PONS_V2_FACTORY}, but this build is verified against ` +
        `${contracts.ponsV2Factory} on chain ${env.CHAIN_ID}.\n` +
        `The deploy block, ABIs and documented facts all belong to that deployment, so ` +
        `indexing a different factory with them would produce confident but wrong data.\n` +
        `Either unset PONS_V2_FACTORY, or add the new deployment to CONTRACTS in ` +
        `@stunks/config and re-run \`pnpm verify:pons\` against it first.`,
    );
  }

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
