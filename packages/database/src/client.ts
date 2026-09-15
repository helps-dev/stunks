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

export type { PrismaClient };
