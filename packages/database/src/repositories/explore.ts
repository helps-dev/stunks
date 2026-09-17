import type { Prisma } from "@prisma/client";
import { type GraduationPhase, type PrismaClient } from "@prisma/client";
import { toBigInt, toDecimal } from "../amount.js";

/**
 * Explore and token-detail queries.
 *
 * Two rules shape every query here.
 *
 * CURSOR, NEVER OFFSET. At the observed launch rate — roughly 13 per 226 blocks —
 * `tokens` grows continuously, and `OFFSET 5000` makes Postgres walk 5,000 rows it
 * then discards. Worse, a row inserted during paging shifts every subsequent page and
 * silently duplicates or skips entries. A cursor is stable against concurrent inserts.
 *
 * MONEY LEAVES AS bigint. Rows come back with Decimal columns converted at the
 * boundary, so nothing downstream is tempted to call `.toNumber()` on a uint256.
 */

export type ExploreSort =
  | "NEW"
  | "VOLUME_24H"
  | "MARKET_CAP"
  | "GRADUATING"
  | "TRENDING"
  | "LAST_TRADE";

export interface ExploreFilters {
  readonly chainId: number;
  readonly sort: ExploreSort;
  readonly limit: number;
  /** Opaque cursor from the previous page. */
  readonly cursor?: string;
  readonly search?: string;
  readonly phases?: readonly GraduationPhase[];
  readonly minVolume24h?: bigint;
  readonly minMarketCap?: bigint;
  /** Only tokens launched within this many hours. */
  readonly maxAgeHours?: number;
  /** Hidden and flagged tokens are excluded unless explicitly asked for. */
  readonly includeModerated?: boolean;
}

export interface TokenSummary {
  readonly id: string;
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly imageUrl: string | null;
  readonly creatorAddress: string;
  readonly pairTokenAddress: string;
  readonly pairTokenDecimals: number;
  readonly phase: GraduationPhase;
  readonly price: bigint;
  readonly marketCap: bigint;
  readonly volume24h: bigint;
  readonly volumeTotal: bigint;
  readonly graduationBps: number;
  readonly holderCount: number;
  readonly tradeCount: number;
  readonly creatorTaxBps: number;
  readonly totalSupply: bigint;
  readonly hadWhitelistBundle: boolean;
  readonly whitelistSize: number;
  readonly moderationStatus: string;
  readonly launchBlock: bigint;
  readonly createdAt: Date;
  readonly lastTradeAt: Date | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Cursor encoding.
 *
 * Carries the sort key alongside the row id, because a cursor is only meaningful for
 * the ordering it was produced under. Encoding the sort makes a mismatched cursor
 * detectable instead of silently returning nonsense.
 */
interface DecodedCursor {
  readonly sort: ExploreSort;
  readonly id: string;
}

function encodeCursor(sort: ExploreSort, id: string): string {
  return Buffer.from(JSON.stringify({ sort, id })).toString("base64url");
}

function decodeCursor(cursor: string, expectedSort: ExploreSort): DecodedCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    ) as DecodedCursor;
    if (parsed.sort !== expectedSort || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Ordering per sort. Every one ends with `id` so the order is total and stable. */
function orderFor(sort: ExploreSort): Prisma.TokenOrderByWithRelationInput[] {
  switch (sort) {
    case "NEW":
      return [{ launchBlock: "desc" }, { id: "desc" }];
    case "VOLUME_24H":
      return [{ volume24h: "desc" }, { id: "desc" }];
    case "MARKET_CAP":
      return [{ marketCap: "desc" }, { id: "desc" }];
    case "GRADUATING":
      return [{ graduationBps: "desc" }, { id: "desc" }];
    case "TRENDING":
      // Sorts a column nothing currently writes. `scoreTrending` in ../trending.ts
      // computes it and is covered by tests, but it has no caller, so every row holds
      // the default 0 and this degenerates to `id desc` — an arbitrary order shown to
      // the user as "trending". `anyTrendingScore` exists so the UI can say so instead
      // of presenting it as a ranking. See R41.
      return [{ trendingScore: "desc" }, { id: "desc" }];
    case "LAST_TRADE":
      return [{ lastTradeAt: "desc" }, { id: "desc" }];
  }
}

export interface SeenPairToken {
  readonly address: string;
  readonly decimals: number;
  /** Number of indexed launches that historically used this candidate. */
  readonly launchCount: number;
}

export class ExploreRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listTokens(filters: ExploreFilters): Promise<Page<TokenSummary>> {
    const where: Prisma.TokenWhereInput = { chainId: filters.chainId };

    // Hidden and flagged tokens stay out of discovery by default. They remain on-chain
    // and reachable by direct address — STUNKS cannot and should not pretend otherwise.
    if (filters.includeModerated !== true) {
      where.moderationStatus = { notIn: ["HIDDEN", "FLAGGED"] };
    }

    if (filters.phases && filters.phases.length > 0) {
      where.phase = { in: [...filters.phases] };
    }

    if (filters.search && filters.search.trim() !== "") {
      const term = filters.search.trim();
      where.OR = [
        { symbol: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
        // An exact address match, so pasting a contract address finds it.
        { address: term.toLowerCase() },
      ];
    }

    if (filters.minVolume24h !== undefined) {
      where.volume24h = { gte: toDecimal(filters.minVolume24h) };
    }
    if (filters.minMarketCap !== undefined) {
      where.marketCap = { gte: toDecimal(filters.minMarketCap) };
    }
    if (filters.maxAgeHours !== undefined) {
      where.createdAt = {
        gte: new Date(Date.now() - filters.maxAgeHours * 60 * 60 * 1000),
      };
    }

    // Graduating means "on the curve and making progress" — a graduated token is not
    // graduating, and a token at 0% is not either.
    if (filters.sort === "GRADUATING") {
      where.phase = "NOT_GRADUATED";
      where.graduationBps = { gt: 0 };
    }

    const cursor = filters.cursor ? decodeCursor(filters.cursor, filters.sort) : null;

    // Fetch one extra row to learn whether another page exists, without a second
    // count query over a growing table.
    const rows = await this.prisma.token.findMany({
      where,
      orderBy: orderFor(filters.sort),
      take: filters.limit + 1,
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
    });

    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map(toSummary),
      nextCursor: hasMore && last ? encodeCursor(filters.sort, last.id) : null,
      hasMore,
    };
  }

  /** Full token detail. Indexed state only — the caller pairs it with a live read. */
  async getToken(chainId: number, address: string) {
    const token = await this.prisma.token.findUnique({
      where: { chainId_address: { chainId, address: address.toLowerCase() } },
      include: { pool: true, creator: true },
    });
    if (!token) return null;

    return {
      ...toSummary(token),
      description: token.description,
      websiteUrl: token.websiteUrl,
      twitterUrl: token.twitterUrl,
      telegramUrl: token.telegramUrl,
      discordUrl: token.discordUrl,
      farcasterUrl: token.farcasterUrl,
      curveAddress: token.curveAddress,
      deployerAddress: token.deployerAddress,
      graduationThreshold: toBigInt(token.graduationThreshold),
      realQuoteReserve: toBigInt(token.realQuoteReserve),
      phantomQuote: toBigInt(token.phantomQuote),
      reservedTokens: toBigInt(token.reservedTokens),
      poolFee: token.poolFee,
      tickSpacing: token.tickSpacing,
      buybackEnabled: token.buybackEnabled,
      snipeTaxStartBps: token.snipeTaxStartBps,
      snipeTaxSeconds: token.snipeTaxSeconds,
      launchedAt: token.launchedAt,
      launchTxHash: token.launchTxHash,
      buyCount: token.buyCount,
      sellCount: token.sellCount,
      pool: token.pool
        ? {
            poolId: token.pool.poolId,
            currency0: token.pool.currency0,
            currency1: token.pool.currency1,
            hookAddress: token.pool.hookAddress,
            graduatedAt: token.pool.graduatedAt,
            graduationTxHash: token.pool.graduationTxHash,
          }
        : null,
      creator: {
        address: token.creator.address,
        tokenCount: token.creator.tokenCount,
        graduatedCount: token.creator.graduatedCount,
        totalVolume: toBigInt(token.creator.totalVolume),
      },
    };
  }

  /** Recent trades for a token page. Cursor-paginated: history is unbounded. */
  async listTrades(args: { tokenId: string; limit: number; cursor?: string }) {
    const rows = await this.prisma.trade.findMany({
      where: { tokenId: args.tokenId },
      orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
      take: args.limit + 1,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > args.limit;
    const page = hasMore ? rows.slice(0, args.limit) : rows;

    return {
      items: page.map((trade) => ({
        id: trade.id,
        side: trade.side,
        venue: trade.venue,
        traderAddress: trade.traderAddress,
        recipientAddress: trade.recipientAddress,
        tokenAmount: toBigInt(trade.tokenAmount),
        quoteAmount: toBigInt(trade.quoteAmount),
        price: toBigInt(trade.price),
        feeAmount: toBigInt(trade.feeAmount),
        creatorTaxAmount: toBigInt(trade.creatorTaxAmount),
        transactionHash: trade.transactionHash,
        blockNumber: trade.blockNumber,
        timestamp: trade.timestamp,
      })),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      hasMore,
    };
  }

  /** Top holders. Protocol accounts are excluded — they are not holders. */
  async listHolders(args: { tokenId: string; limit: number }) {
    const rows = await this.prisma.holder.findMany({
      where: { tokenId: args.tokenId, isProtocolAccount: false, balance: { gt: 0 } },
      orderBy: { balance: "desc" },
      take: args.limit,
    });
    return rows.map((holder) => ({
      walletAddress: holder.walletAddress,
      balance: toBigInt(holder.balance),
    }));
  }

  /**
   * Platform totals.
   *
   * Deliberately has no revenue figure. Pons V2 routes nothing to third-party
   * interfaces, so any number here would be invented.
   */
  async platformStats(chainId: number) {
    const [tokens, graduated, trades, creators, volume] = await Promise.all([
      this.prisma.token.count({ where: { chainId } }),
      this.prisma.token.count({ where: { chainId, phase: "POOL_CREATED" } }),
      this.prisma.trade.count({ where: { chainId } }),
      this.prisma.creator.count({ where: { chainId } }),
      this.prisma.trade.aggregate({ where: { chainId }, _sum: { quoteAmount: true } }),
    ]);

    const sum = volume._sum.quoteAmount;
    return {
      tokenCount: tokens,
      graduatedCount: graduated,
      tradeCount: trades,
      creatorCount: creators,
      totalVolume: sum === null ? 0n : BigInt(sum.toFixed()),
      platformRevenue: 0n,
    };
  }

  /**
   * Pair assets observed in real indexed Pons launches.
   *
   * This is discovery data, NOT an approval list: Pons exposes membership checks but
   * no pair-token enumeration. A caller must re-check `approvedPairTokens` on-chain
   * before offering one as a selectable launch pair.
   */
  async listSeenPairTokens(
    chainId: number,
    limit = 24,
  ): Promise<readonly SeenPairToken[]> {
    const groups = await this.prisma.token.groupBy({
      by: ["pairTokenAddress", "pairTokenDecimals"],
      where: { chainId },
      _count: { _all: true },
    });

    return groups
      .sort((left, right) => right._count._all - left._count._all)
      .slice(0, limit)
      .map((group) => ({
        address: group.pairTokenAddress,
        decimals: group.pairTokenDecimals,
        launchCount: group._count._all,
      }));
  }

  /**
   * Whether any token carries a trending score at all.
   *
   * Cheap: `(chainId, trendingScore desc)` is indexed, and the answer is whatever the
   * first row says. Asked so the UI can distinguish "nothing is trending" from
   * "nothing has been scored", which look identical in the result set and mean
   * entirely different things.
   */
  async anyTrendingScore(chainId: number): Promise<boolean> {
    const top = await this.prisma.token.findFirst({
      where: { chainId, trendingScore: { gt: 0 } },
      select: { id: true },
    });
    return top !== null;
  }

  /** How far behind the indexer is, so the UI can be honest about staleness. */
  async indexerLag(chainId: number) {
    const states = await this.prisma.indexerState.findMany({ where: { chainId } });
    return states.map((state) => ({
      stream: state.stream,
      lastProcessedBlock: state.lastProcessedBlock,
      lastSuccessAt: state.lastSuccessAt,
      isPaused: state.isPaused,
    }));
  }
}

type TokenRow = Prisma.TokenGetPayload<Record<string, never>>;

function toSummary(token: TokenRow): TokenSummary {
  return {
    id: token.id,
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    imageUrl: token.imageUrl,
    creatorAddress: token.creatorAddress,
    pairTokenAddress: token.pairTokenAddress,
    pairTokenDecimals: token.pairTokenDecimals,
    phase: token.phase,
    price: toBigInt(token.price),
    marketCap: toBigInt(token.marketCap),
    volume24h: toBigInt(token.volume24h),
    volumeTotal: toBigInt(token.volumeTotal),
    graduationBps: token.graduationBps,
    holderCount: token.holderCount,
    tradeCount: token.tradeCount,
    creatorTaxBps: token.creatorTaxBps,
    totalSupply: toBigInt(token.totalSupply),
    hadWhitelistBundle: token.hadWhitelistBundle,
    whitelistSize: token.whitelistSize,
    moderationStatus: token.moderationStatus,
    launchBlock: token.launchBlock,
    createdAt: token.createdAt,
    lastTradeAt: token.lastTradeAt,
  };
}
