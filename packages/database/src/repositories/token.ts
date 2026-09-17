import { Prisma, type GraduationPhase, type PrismaClient } from "@prisma/client";
import { toDecimal } from "../amount.js";

/**
 * Token and creator writes.
 *
 * A note on trust levels, because this is where they meet. The fields written by
 * `recordLaunch` are on-chain canonical — they come from a `TokenLaunched` event and
 * a factory read, and are never recomputed. The fields written by `updateStats` are
 * indexed-derived: our own aggregates, which can be rebuilt from trades and must
 * never be treated as authoritative. Moderation fields are ours alone and are not
 * a substitute for chain truth.
 *
 * Keeping those three groups in separate methods is deliberate. A single
 * `updateToken` that could touch any column would make it easy to overwrite
 * canonical data with a derived guess.
 */

export interface LaunchRecordInput {
  readonly chainId: number;
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals?: number;
  readonly imageUrl?: string;
  readonly description?: string;
  readonly websiteUrl?: string;
  readonly twitterUrl?: string;
  readonly telegramUrl?: string;
  readonly discordUrl?: string;
  readonly farcasterUrl?: string;
  /**
   * When the launch calldata was examined for the fields above.
   *
   * Set even when nothing was found: the calldata of a mined transaction cannot
   * change, so a miss is permanent and the backfill must not pay for it twice.
   */
  readonly metadataCheckedAt?: Date;

  readonly creatorAddress: string;
  readonly deployerAddress: string;
  readonly curveAddress: string;
  readonly pairTokenAddress: string;
  /** USDG uses 6. Never assume 18 for a pair asset. */
  readonly pairTokenDecimals: number;
  readonly launchConfigId: bigint;

  readonly totalSupply: bigint;
  readonly creatorTaxBps: number;
  readonly buybackEnabled: boolean;
  readonly graduationThreshold: bigint;
  readonly poolFee: number;
  readonly tickSpacing: number;
  readonly phantomQuote: bigint;
  readonly reservedTokens: bigint;

  readonly snipeTaxStartBps?: number;
  readonly snipeTaxSeconds?: number;
  readonly launchedAt?: Date;

  readonly launchBlock: bigint;
  readonly launchTxHash: string;

  /**
   * Disclosed on the token page. Traders deserve to know the opening distribution
   * was concentrated, so this is recorded at launch rather than inferred later.
   */
  readonly whitelistSize?: number;

  /**
   * Opening price and reserve, folded into the same write.
   *
   * Kept here rather than in a follow-up `updateStats` call for a measured reason:
   * launches arrive fast enough on this chain that a second round trip to a remote
   * serverless Postgres was a material share of the indexer's throughput.
   */
  readonly openingPrice?: bigint;
  readonly openingMarketCap?: bigint;
  readonly openingRealQuoteReserve?: bigint;
}

export interface TokenStatsInput {
  readonly realQuoteReserve: bigint;
  readonly graduationBps: number;
  readonly price: bigint;
  readonly marketCap: bigint;
  readonly volume24h: bigint;
  readonly volumeTotal: bigint;
  readonly holderCount: number;
  readonly tradeCount: number;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly lastTradeAt?: Date;
}

export class TokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record a launch idempotently, creating the creator if needed.
   *
   * Wrapped in a transaction because a token without its creator row is a broken
   * state that later reads would have to defend against.
   */
  async recordLaunch(
    input: LaunchRecordInput,
  ): Promise<{ tokenId: string; created: boolean }> {
    const address = input.address.toLowerCase();
    const creatorAddress = input.creatorAddress.toLowerCase();

    const existing = await this.prisma.token.findUnique({
      where: { chainId_address: { chainId: input.chainId, address } },
      select: { id: true },
    });
    if (existing) return { tokenId: existing.id, created: false };

    try {
      const tokenId = await this.prisma.$transaction(async (tx) => {
        const creator = await tx.creator.upsert({
          where: { chainId_address: { chainId: input.chainId, address: creatorAddress } },
          create: { chainId: input.chainId, address: creatorAddress, tokenCount: 1 },
          update: { tokenCount: { increment: 1 } },
        });

        const token = await tx.token.create({
          data: {
            chainId: input.chainId,
            address,
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
            metadataCheckedAt: input.metadataCheckedAt ?? null,

            creatorAddress,
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

            // A launch that has not traded still has a price: the curve opens
            // against a virtual reserve. Written here so the indexer needs one
            // round trip per launch rather than two.
            price: toDecimal(input.openingPrice ?? 0n),
            marketCap: toDecimal(input.openingMarketCap ?? 0n),
            realQuoteReserve: toDecimal(input.openingRealQuoteReserve ?? 0n),

            creatorId: creator.id,
          },
          select: { id: true },
        });

        return token.id;
      });

      return { tokenId, created: true };
    } catch (error) {
      // Concurrent worker won the race. Re-read rather than fail the batch.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const token = await this.prisma.token.findUniqueOrThrow({
          where: { chainId_address: { chainId: input.chainId, address } },
          select: { id: true },
        });
        return { tokenId: token.id, created: false };
      }
      throw error;
    }
  }

  /** Indexed-derived aggregates only. Cannot touch canonical launch data. */
  async updateStats(tokenId: string, stats: TokenStatsInput): Promise<void> {
    await this.prisma.token.update({
      where: { id: tokenId },
      data: {
        realQuoteReserve: toDecimal(stats.realQuoteReserve),
        graduationBps: stats.graduationBps,
        price: toDecimal(stats.price),
        marketCap: toDecimal(stats.marketCap),
        volume24h: toDecimal(stats.volume24h),
        volumeTotal: toDecimal(stats.volumeTotal),
        holderCount: stats.holderCount,
        tradeCount: stats.tradeCount,
        buyCount: stats.buyCount,
        sellCount: stats.sellCount,
        ...(stats.lastTradeAt ? { lastTradeAt: stats.lastTradeAt } : {}),
      },
    });
  }

  /**
   * Phase transitions come from a live on-chain read, never from a guess. The
   * caller is responsible for having read `getLaunchedToken().phase`.
   */
  async setPhase(tokenId: string, phase: GraduationPhase): Promise<void> {
    await this.prisma.token.update({ where: { id: tokenId }, data: { phase } });
  }

  async findByAddress(chainId: number, address: string) {
    return this.prisma.token.findUnique({
      where: { chainId_address: { chainId, address: address.toLowerCase() } },
    });
  }

  async findById(tokenId: string) {
    return this.prisma.token.findUnique({ where: { id: tokenId } });
  }

  /** Curve address is the join key for `CurveBuy` / `CurveSell` logs. */
  async findByCurve(chainId: number, curveAddress: string) {
    return this.prisma.token.findUnique({
      where: {
        chainId_curveAddress: { chainId, curveAddress: curveAddress.toLowerCase() },
      },
    });
  }

  /**
   * Every curve address the indexer needs to subscribe to. There is one curve
   * contract per launch, so this list grows with every token and is what the
   * per-curve log filter is built from.
   */
  async listActiveCurves(chainId: number): Promise<string[]> {
    const rows = await this.prisma.token.findMany({
      where: { chainId, phase: "NOT_GRADUATED" },
      select: { curveAddress: true },
    });
    return rows.map((row) => row.curveAddress);
  }

  /**
   * Earliest block at which any tracked curve existed.
   *
   * The curve stream has no reason to scan before this: a curve cannot emit a trade
   * before it is deployed. Without this the stream started at the factory deploy
   * block and burned ~44 hours scanning 36.8M blocks that could not contain a single
   * matching log.
   *
   * Returns null when nothing is indexed yet, so the caller can wait rather than
   * defaulting to genesis.
   */
  async earliestLaunchBlock(chainId: number): Promise<bigint | null> {
    const row = await this.prisma.token.aggregate({
      where: { chainId },
      _min: { launchBlock: true },
    });
    return row._min.launchBlock ?? null;
  }

  async deleteAboveBlock(chainId: number, blockNumber: bigint): Promise<number> {
    const result = await this.prisma.token.deleteMany({
      where: { chainId, launchBlock: { gt: blockNumber } },
    });
    return result.count;
  }
}
