import { z } from "zod";
import { isAddress } from "viem";
import { ROBINHOOD_CHAIN_ID } from "./chain.js";

/**
 * Environment parsing.
 *
 * Fails fast and never falls back to a default for anything that could put a
 * transaction on the wrong chain or point at the wrong contract. A misconfigured
 * deployment should refuse to start rather than quietly trade somewhere else.
 */

const addressSchema = z
  .string()
  .refine((value) => isAddress(value), { message: "must be a valid EVM address" })
  .transform((value) => value as `0x${string}`);

const endpointListSchema = z
  .string()
  .min(1, "at least one RPC endpoint is required")
  .transform((value, ctx) => {
    const endpoints = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (endpoints.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "no RPC endpoints parsed" });
      return z.NEVER;
    }

    for (const endpoint of endpoints) {
      let parsed: URL;
      try {
        parsed = new URL(endpoint);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `not a valid URL: ${endpoint}`,
        });
        return z.NEVER;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `RPC endpoint must be http(s): ${endpoint}`,
        });
        return z.NEVER;
      }
    }
    return endpoints;
  });

const chainIdSchema = z.coerce
  .number()
  .int()
  .positive()
  .refine((id) => id === ROBINHOOD_CHAIN_ID, {
    message: `only Robinhood Chain (${ROBINHOOD_CHAIN_ID}) is supported in V1`,
  });

/** Server-side config: indexer, API, scripts. */
export const serverEnvSchema = z.object({
  CHAIN_ID: chainIdSchema.default(ROBINHOOD_CHAIN_ID),
  RPC_ENDPOINTS: endpointListSchema,
  PONS_V2_FACTORY: addressSchema,
  INDEXER_START_BLOCK: z.coerce.bigint().nonnegative(),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  RUN_LIVE_TESTS: z.enum(["0", "1"]).default("0"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Browser-side config. Deliberately cannot reference a private endpoint. */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_CHAIN_ID: chainIdSchema.default(ROBINHOOD_CHAIN_ID),
  NEXT_PUBLIC_RPC_ENDPOINTS: endpointListSchema,
  NEXT_PUBLIC_PONS_V2_FACTORY: addressSchema,
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  /**
   * The project's own token, given a spotlight above the explore grid.
   *
   * Optional, and absent is the normal state: before a launch there is no such token,
   * and the spotlight simply does not render. An empty string is treated as absent so
   * the variable can sit in a deployment's settings, blank, until the day it is
   * needed — otherwise setting it up would require a code change on launch day.
   *
   * Pointing it at an address the indexer has not reached yet renders nothing rather
   * than an empty frame. The spotlight shows indexed figures, so it can only appear
   * once there are indexed figures to show.
   */
  NEXT_PUBLIC_OFFICIAL_TOKEN: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === "" ? undefined : value))
    .refine((value) => value === undefined || isAddress(value), {
      message: "must be a valid EVM address, or left unset",
    })
    .transform((value) => value as `0x${string}` | undefined),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

function describeFailure(name: string, error: z.ZodError): never {
  const details = error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Invalid ${name} configuration.\n${details}\n\nSee .env.example for the expected values.`,
  );
}

export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) describeFailure("server", parsed.error);
  return parsed.data;
}

export function loadClientEnv(source: Record<string, string | undefined>): ClientEnv {
  const parsed = clientEnvSchema.safeParse(source);
  if (!parsed.success) describeFailure("client", parsed.error);
  return parsed.data;
}

/** True when live read-only mainnet tests are explicitly enabled. */
export function liveTestsEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.RUN_LIVE_TESTS === "1";
}
