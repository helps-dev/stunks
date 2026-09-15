import type { PrismaClient } from "@prisma/client";
import { CheckpointRepository } from "./checkpoint.js";
import { TokenRepository } from "./token.js";
import { TradeRepository } from "./trade.js";

export * from "./checkpoint.js";
export * from "./token.js";
export * from "./trade.js";

/**
 * Repository bundle.
 *
 * These exist so that the indexer never writes raw Prisma calls: every write path
 * that has an idempotency requirement is encapsulated where it can be tested, and
 * the canonical / derived / moderation trust boundaries are enforced by which
 * method you are allowed to call.
 */
export interface Repositories {
  readonly checkpoints: CheckpointRepository;
  readonly tokens: TokenRepository;
  readonly trades: TradeRepository;
}

export function createRepositories(prisma: PrismaClient): Repositories {
  return {
    checkpoints: new CheckpointRepository(prisma),
    tokens: new TokenRepository(prisma),
    trades: new TradeRepository(prisma),
  };
}
