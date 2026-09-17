import type { Prisma, PrismaClient } from "@prisma/client";
import { toDecimal } from "../amount.js";
import type { LaunchRecordInput } from "./token.js";

/**
 * Batched launch writes.
 *
 * Measured problem: `recordLaunch` opens a transaction per launch (creator upsert plus
 * token insert), and against a remote serverless Postgres each one costs several
 * hundred milliseconds. At the observed rate of roughly 13 launches per 226 blocks, the
 * indexer spent ~2.7 s per launch and fell steadily behind a chain producing 10
 * blocks/second.
 *
 * This collapses one scan window into three round trips regardless of how many launches
 * it contains:
 *
 *   1. read which creators already exist
 *   2. createMany the missing creators
 *   3. createMany the tokens
 *
 * `skipDuplicates` keeps it idempotent, which matters more here than the speed: an
 * overlapping window or a replayed batch must not double-write, and the unique
 * constraints are what actually enforce that.
 *
 * The trade-off, stated plainly: creator `tokenCount` is no longer incremented inside a
 * transaction per launch. It is recomputed from the token table instead, which is
 * self-healing after a replay rather than permanently inflated by one.
 */

export interface BatchResult {
  readonly creatorsCreated: number;
  readonly tokensCreated: number;
  readonly skipped: number;
}

export class LaunchBatchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Write a window's launches.
   *
   * Returns counts rather than rows: the caller is an indexer that wants throughput
   * numbers, and hydrating hundreds of rows it will not read would defeat the purpose.
   */
  async recordLaunches(
    chainId: number,
    launches: readonly LaunchRecordInput[],
  ): Promise<BatchResult> {
    if (launches.length === 0) {
      return { creatorsCreated: 0, tokensCreated: 0, skipped: 0 };
    }

    // Deduplicate within the batch first. The same token cannot legitimately appear
    // twice in one window, but an overlapping re-scan can produce it.
    const byAddress = new Map<string, LaunchRecordInput>();
    for (const launch of launches) {
      byAddress.set(launch.address.toLowerCase(), launch);
    }
    const unique = [...byAddress.values()];

    const creatorAddresses = [
      ...new Set(unique.map((launch) => launch.creatorAddress.toLowerCase())),
    ];

    // ── 1. which creators exist already ──
    const existingCreators = await this.prisma.creator.findMany({
      where: { chainId, address: { in: creatorAddresses } },
      select: { id: true, address: true },
    });
    const creatorIdByAddress = new Map(
      existingCreators.map((creator) => [creator.address, creator.id]),
    );

    // ── 2. create the missing ones ──
    const missing = creatorAddresses.filter(
      (address) => !creatorIdByAddress.has(address),
    );
    let creatorsCreated = 0;
    if (missing.length > 0) {
      const result = await this.prisma.creator.createMany({
        data: missing.map((address) => ({ chainId, address })),
        skipDuplicates: true,
      });
      creatorsCreated = result.count;

      // Re-read to pick up ids, including any a concurrent worker inserted between the
      // check and the write.
      const created = await this.prisma.creator.findMany({
        where: { chainId, address: { in: missing } },
        select: { id: true, address: true },
      });
      for (const creator of created) {
        creatorIdByAddress.set(creator.address, creator.id);
      }
    }

    // ── 3. create the tokens ──
    const rows: Prisma.TokenCreateManyInput[] = [];
    let skipped = 0;

    for (const launch of unique) {
      const creatorId = creatorIdByAddress.get(launch.creatorAddress.toLowerCase());
      if (!creatorId) {
        // Should not happen, but writing a token with a dangling creator would be
        // worse than skipping it and letting the next scan retry.
        skipped++;
        continue;
      }
      rows.push(toTokenRow(chainId, launch, creatorId));
    }

    const inserted =
      rows.length > 0
        ? await this.prisma.token.createMany({ data: rows, skipDuplicates: true })
        : { count: 0 };

    return { creatorsCreated, tokensCreated: inserted.count, skipped };
  }

  /**
   * Recompute creator aggregates from the token table.
   *
   * Recomputed rather than incremented, deliberately. An incremented counter is wrong
   * forever after a single replay or rollback; a recomputed one repairs itself. Run
   * periodically rather than per launch.
   */
  async refreshCreatorCounts(chainId: number): Promise<number> {
    const result = await this.prisma.$executeRaw`
      UPDATE creators c
      SET "tokenCount" = sub.total,
          "graduatedCount" = sub.graduated,
          "updatedAt" = now()
      FROM (
        SELECT "creatorId",
               count(*)::int AS total,
               count(*) FILTER (WHERE phase = 'POOL_CREATED')::int AS graduated
        FROM tokens
        WHERE "chainId" = ${chainId}
        GROUP BY "creatorId"
      ) AS sub
      WHERE c.id = sub."creatorId"
        AND (c."tokenCount" <> sub.total OR c."graduatedCount" <> sub.graduated)
    `;
    return result;
  }
}

function toTokenRow(
  chainId: number,
  input: LaunchRecordInput,
  creatorId: string,
): Prisma.TokenCreateManyInput {
  return {
    chainId,
    address: input.address.toLowerCase(),
    name: input.name,
    symbol: input.symbol,
    decimals: input.decimals ?? 18,
    imageUrl: input.imageUrl ?? null,
    description: input.description ?? null,
    websiteUrl: input.websiteUrl ?? null,
    twitterUrl: input.twitterUrl ?? null,
    telegramUrl: input.telegramUrl ?? null,
    discordUrl: input.discordUrl ?? null,
    farcasterUrl: input.farcasterUrl ?? null,

    creatorAddress: input.creatorAddress.toLowerCase(),
    deployerAddress: input.deployerAddress.toLowerCase(),
    curveAddress: input.curveAddress.toLowerCase(),
    pairTokenAddress: input.pairTokenAddress.toLowerCase(),
    pairTokenDecimals: input.pairTokenDecimals,
    launchConfigId: input.launchConfigId,

    totalSupply: toDecimal(input.totalSupply),
    creatorTaxBps: input.creatorTaxBps,
    buybackEnabled: input.buybackEnabled,
    graduationThreshold: toDecimal(input.graduationThreshold),
    poolFee: input.poolFee,
    tickSpacing: input.tickSpacing,
    phantomQuote: toDecimal(input.phantomQuote),
    reservedTokens: toDecimal(input.reservedTokens),

    snipeTaxStartBps: input.snipeTaxStartBps ?? null,
    snipeTaxSeconds: input.snipeTaxSeconds ?? null,
    launchedAt: input.launchedAt ?? null,

    launchBlock: input.launchBlock,
    launchTxHash: input.launchTxHash,

    hadWhitelistBundle: (input.whitelistSize ?? 0) > 0,
    whitelistSize: input.whitelistSize ?? 0,

    price: toDecimal(input.openingPrice ?? 0n),
    marketCap: toDecimal(input.openingMarketCap ?? 0n),
    realQuoteReserve: toDecimal(input.openingRealQuoteReserve ?? 0n),

    creatorId,
  };
}
