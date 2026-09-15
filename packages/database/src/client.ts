import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton.
 *
 * Next.js dev-mode hot reload re-evaluates modules, which without this guard opens
 * a new connection pool on every reload until Postgres refuses more.
 */

const globalForPrisma = globalThis as unknown as { stunksPrisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.stunksPrisma) {
    globalForPrisma.stunksPrisma = new PrismaClient({
      log: process.env.NODE_ENV === "production" ? ["warn", "error"] : ["warn", "error"],
    });
  }
  return globalForPrisma.stunksPrisma;
}

export function isDatabaseAvailabilityError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : undefined;
  // Prisma's documented availability/pool failure codes. They are retryable because
  // neither says anything about the correctness of a chain block or decoded event.
  if (code === "P1001" || code === "P1017" || code === "P2024") return true;

  const message =
    error instanceof Error
      ? error.message
      : typeof candidate?.message === "string"
        ? candidate.message
        : String(error);
  return (
    /can't reach database server/i.test(message) ||
    /timed out fetching a new connection from the connection pool/i.test(message) ||
    /server has closed the connection/i.test(message)
  );
}

/**
 * Wait until the database answers.
 *
 * Serverless Postgres (Neon among others) suspends an idle compute and the FIRST
 * connection after that fails outright rather than blocking while it wakes. For a
 * long-running worker that is not an edge case — it happens every time the indexer
 * starts after a quiet period, and crashing on it would make the process unusable
 * without a supervisor.
 *
 * Retries with linear backoff and reports progress, so a slow cold start looks like
 * a slow cold start rather than a hang.
 */
export async function waitForDatabase(
  prisma: PrismaClient,
  options: {
    attempts?: number;
    delayMs?: number;
    onAttempt?: (attempt: number, total: number, error: string) => void;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 2_000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (error) {
      const message =
        error instanceof Error ? error.message.split("\n")[0] : String(error);
      options.onAttempt?.(attempt, attempts, message ?? "unknown error");
      if (attempt === attempts) {
        throw new Error(
          `Database did not become reachable after ${attempts} attempts. ` +
            `Last error: ${message}`,
        );
      }
      // Linear rather than exponential: a suspended compute wakes in seconds, so
      // backing off aggressively just wastes startup time.
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

export type { PrismaClient };
