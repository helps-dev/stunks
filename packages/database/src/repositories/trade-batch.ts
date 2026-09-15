import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { toDecimal } from "../amount.js";
import type { TokenStatsInput } from "./token.js";

/**
 * Batched trade aggregation.
 *
 * The curve processor previously recomputed one token's stats at a time, and each token
 * cost about six sequential database round trips: find the token, three aggregate
 * queries, a chain read, then an update. A single scan window touching 100 tokens
 * therefore cost roughly 600 sequential round trips and the stream stalled — measured at
 * one 126-block tick in six minutes while the factory stream ran at ~100 blocks/second.
 *
 * These methods answer for a whole set of tokens in one query each, using `groupBy`
 * where Prisma supports it and raw SQL where it does not.
 *
 * Same discipline as the launch batching: aggregates are RECOMPUTED from stored rows
 * rather than incremented from a batch, so a replay cannot inflate them and a rollback
 * cannot leave them stale.
 */

export interface TokenTradeAggregate {
  readonly volume: bigint;
  readonly tradeCount: number;
  readonly buyCount: number;
  readonly sellCount: number;
}

export interface LatestTradeInfo {
  readonly price: bigint;
  readonly timestamp: Date;
}

export class TradeBatchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Volume, trade count and buy/sell split for many tokens at once.
   *
   * One `groupBy` for the totals and one for the side split, instead of three queries
   * per token.
   */
  async aggregateForTokens(
    tokenIds: readonly string[],
    options: { since?: Date } = {},
  ): Promise<Map<string, TokenTradeAggregate>> {
    const result = new Map<string, TokenTradeAggregate>();
    if (tokenIds.length === 0) return result;

    const where = {
      tokenId: { in: [...tokenIds] },
      ...(options.since ? { timestamp: { gte: options.since } } : {}),
    };

    const [totals, bySide] = await Promise.all([
      this.prisma.trade.groupBy({
        by: ["tokenId"],
        where,
        _sum: { quoteAmount: true },
        _count: { _all: true },
      }),
      this.prisma.trade.groupBy({
        by: ["tokenId", "side"],
        where,
        _count: { _all: true },
      }),
    ]);

    const buys = new Map<string, number>();
    const sells = new Map<string, number>();
    for (const row of bySide) {
      const target = row.side === "BUY" ? buys : sells;
      target.set(row.tokenId, row._count._all);
    }

    for (const row of totals) {
      const sum = row._sum.quoteAmount;
      result.set(row.tokenId, {
        // Volume is always measured on the quote leg, so buys and sells are comparable.
        volume: sum === null ? 0n : BigInt(sum.toFixed()),
        tradeCount: row._count._all,
        buyCount: buys.get(row.tokenId) ?? 0,
        sellCount: sells.get(row.tokenId) ?? 0,
      });
    }

    // Tokens with no trades in the window are absent from groupBy output. Returning
    // explicit zeros keeps the caller from having to distinguish "no rows" from
    // "not asked about".
    for (const tokenId of tokenIds) {
      if (!result.has(tokenId)) {
        result.set(tokenId, { volume: 0n, tradeCount: 0, buyCount: 0, sellCount: 0 });
      }
    }

    return result;
  }

  /**
   * Most recent trade per token, which defines each token's current price.
   *
   * Raw SQL because this is a per-group latest-row query and Prisma has no first-class
   * way to express it. `DISTINCT ON` is the direct form in Postgres, and it uses the
   * same ordering the index provides.
   *
   * Column names are quoted because the schema uses camelCase columns (documented in
   * the schema header) while table names are snake_case.
   */
  async latestForTokens(
    tokenIds: readonly string[],
  ): Promise<Map<string, LatestTradeInfo>> {
    const result = new Map<string, LatestTradeInfo>();
    if (tokenIds.length === 0) return result;

    const rows = await this.prisma.$queryRaw<
      { tokenId: string; price: string; timestamp: Date }[]
    >`
      SELECT DISTINCT ON ("tokenId")
             "tokenId",
             price::text AS price,
             timestamp
      FROM trades
      WHERE "tokenId" = ANY(${[...tokenIds]}::text[])
      ORDER BY "tokenId", "blockNumber" DESC, "logIndex" DESC
    `;

    for (const row of rows) {
      result.set(row.tokenId, {
        // price arrives as text precisely so it never passes through a float.
        price: BigInt(row.price.split(".")[0] ?? "0"),
        timestamp: row.timestamp,
      });
    }
    return result;
  }
}

/**
 * Batched token lookups and stats writes.
 *
 * Kept alongside the trade aggregation because the curve processor uses all of it in one
 * pass, and splitting it across files would obscure that they exist for the same reason.
 */
export class TokenBatchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Resolve many curve addresses to their tokens in one query.
   *
   * The processor previously issued one `findByCurve` per newly-seen curve in a window.
   * A window spanning hundreds of active launches therefore paid hundreds of sequential
   * round trips before doing any work.
   */
  async findManyByCurves(
    chainId: number,
    curveAddresses: readonly string[],
  ): Promise<
    Map<string, { id: string; address: string; totalSupply: bigint; holderCount: number }>
  > {
    const result = new Map<
      string,
      { id: string; address: string; totalSupply: bigint; holderCount: number }
    >();
    if (curveAddresses.length === 0) return result;

    const normalized = [...new Set(curveAddresses.map((entry) => entry.toLowerCase()))];

    const tokens = await this.prisma.token.findMany({
      where: { chainId, curveAddress: { in: normalized } },
      select: {
        id: true,
        address: true,
        curveAddress: true,
        totalSupply: true,
        holderCount: true,
      },
    });

    for (const token of tokens) {
      result.set(token.curveAddress, {
        id: token.id,
        address: token.address,
        totalSupply: BigInt(token.totalSupply.toFixed()),
        holderCount: token.holderCount,
      });
    }
    return result;
  }

  /** Curve addresses for many tokens, so a batch can be read from chain concurrently. */
  async curveAddressesFor(
    tokenIds: readonly string[],
  ): Promise<Map<string, { curveAddress: string; totalSupply: bigint; holderCount: number }>> {
    const result = new Map<
      string,
      { curveAddress: string; totalSupply: bigint; holderCount: number }
    >();
    if (tokenIds.length === 0) return result;

    const tokens = await this.prisma.token.findMany({
      where: { id: { in: [...tokenIds] } },
      select: { id: true, curveAddress: true, totalSupply: true, holderCount: true },
    });

    for (const token of tokens) {
      result.set(token.id, {
        curveAddress: token.curveAddress,
        totalSupply: BigInt(token.totalSupply.toFixed()),
        holderCount: token.holderCount,
      });
    }
    return result;
  }

  /**
   * Write indexed-derived stats for a whole curve window in one round trip.
   *
   * `updateStats` is intentionally kept for single-token callers. A busy curve window
   * may touch 50–100 tokens, however, and one Prisma update per token both consumes
   * Neon pool connections and spends tens of seconds on round-trip latency. This is a
   * set-based Postgres update: each value row is lossless Decimal(78,0), and only the
   * indexed-derived columns that `TokenRepository.updateStats` is allowed to touch are
   * present in the SET list.
   *
   * `lastTradeAt` mirrors the single-token method's semantics: an absent last trade
   * leaves the existing timestamp intact rather than replacing it with null.
   */
  async updateStatsMany(
    rows: readonly { readonly tokenId: string; readonly stats: TokenStatsInput }[],
  ): Promise<number> {
    if (rows.length === 0) return 0;

    const values = rows.map(({ tokenId, stats }) => Prisma.sql`
      (
        ${tokenId},
        ${toDecimal(stats.realQuoteReserve)},
        ${stats.graduationBps},
        ${toDecimal(stats.price)},
        ${toDecimal(stats.marketCap)},
        ${toDecimal(stats.volume24h)},
        ${toDecimal(stats.volumeTotal)},
        ${stats.holderCount},
        ${stats.tradeCount},
        ${stats.buyCount},
        ${stats.sellCount},
        ${stats.lastTradeAt ?? null}
      )
    `);

    return this.prisma.$executeRaw`
      UPDATE tokens AS t
      SET
        "realQuoteReserve" = v."realQuoteReserve",
        "graduationBps" = v."graduationBps",
        price = v.price,
        "marketCap" = v."marketCap",
        "volume24h" = v."volume24h",
        "volumeTotal" = v."volumeTotal",
        "holderCount" = v."holderCount",
        "tradeCount" = v."tradeCount",
        "buyCount" = v."buyCount",
        "sellCount" = v."sellCount",
        "lastTradeAt" = COALESCE(v."lastTradeAt", t."lastTradeAt"),
        "updatedAt" = now()
      FROM (
        VALUES ${Prisma.join(values)}
      ) AS v(
        id,
        "realQuoteReserve",
        "graduationBps",
        price,
        "marketCap",
        "volume24h",
        "volumeTotal",
        "holderCount",
        "tradeCount",
        "buyCount",
        "sellCount",
        "lastTradeAt"
      )
      WHERE t.id = v.id
    `;
  }
}
