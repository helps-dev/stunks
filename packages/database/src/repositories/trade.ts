import {
  Prisma,
  type PrismaClient,
  type TradeSide,
  type TradeVenue,
} from "@prisma/client";
import { toDecimal } from "../amount.js";

/**
 * Trade writes.
 *
 * The entire design of this file is about one property: **replaying a log must
 * never double-count a trade.** At ~852,912 blocks per day, with adaptive log
 * windows and retries after RPC failures, overlapping scans are not an edge case —
 * they are the normal operating condition.
 *
 * So every write is keyed on `(chainId, transactionHash, logIndex)` and uses an
 * upsert whose `update` clause is empty. Re-processing is a no-op by construction,
 * not by the caller remembering to check first.
 */

export interface TradeInput {
  readonly chainId: number;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly tokenId: string;
  readonly curveAddress: string | null;
  readonly venue: TradeVenue;
  /** Who sent the transaction. */
  readonly traderAddress: string;
  /**
   * Who received the tokens. Distinct from the trader on purpose: the anti-snipe
   * tax is evaluated per recipient, and a whitelist bundle has one payer and many
   * recipients.
   */
  readonly recipientAddress: string;
  readonly side: TradeSide;
  readonly tokenAmount: bigint;
  readonly quoteAmount: bigint;
  readonly feeAmount: bigint;
  readonly creatorTaxAmount: bigint;
  readonly snipeTaxAmount: bigint;
  /** Surplus returned when a buy was clamped to reservedTokens. */
  readonly refundAmount: bigint;
  readonly price: bigint;
  readonly marketCap: bigint;
  readonly timestamp: Date;
  readonly excludedFromCompetition?: boolean;
  readonly exclusionReason?: string;
}

export class TradeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Insert a trade, or do nothing if this exact log was already indexed.
   *
   * The empty `update` is the point. It means a replayed window cannot mutate an
   * existing row either — an indexed trade is immutable, because the chain event it
   * came from is immutable.
   */
  async record(input: TradeInput): Promise<{ created: boolean }> {
    const existing = await this.prisma.trade.findUnique({
      where: {
        chainId_transactionHash_logIndex: {
          chainId: input.chainId,
          transactionHash: input.transactionHash,
          logIndex: input.logIndex,
        },
      },
      select: { id: true },
    });
    if (existing) return { created: false };

    try {
      await this.prisma.trade.create({ data: this.toCreateData(input) });
      return { created: true };
    } catch (error) {
      // Lost a race with a concurrent worker on the same log. That is a success
      // for our purposes: the row exists and is identical.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return { created: false };
      }
      throw error;
    }
  }

  /**
   * Batch insert for backfill. `skipDuplicates` makes an overlapping window cheap
   * instead of an error, which matters when the adaptive window size changes and
   * ranges re-overlap.
   */
  async recordMany(inputs: readonly TradeInput[]): Promise<{ inserted: number }> {
    if (inputs.length === 0) return { inserted: 0 };
    const result = await this.prisma.trade.createMany({
      data: inputs.map((input) => this.toCreateData(input)),
      skipDuplicates: true,
    });
    return { inserted: result.count };
  }

  /**
   * Delete trades above a block, for reorg recovery. Returns the count so the
   * caller can log what a reorg actually cost.
   */
  async deleteAboveBlock(chainId: number, blockNumber: bigint): Promise<number> {
    const result = await this.prisma.trade.deleteMany({
      where: { chainId, blockNumber: { gt: blockNumber } },
    });
    return result.count;
  }

  /** Cursor-paginated history. Never offset: trade tables grow without bound. */
  async listForToken(args: { tokenId: string; limit: number; cursor?: string }) {
    return this.prisma.trade.findMany({
      where: { tokenId: args.tokenId },
      orderBy: [{ timestamp: "desc" }, { logIndex: "desc" }],
      take: args.limit,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    });
  }

  /**
   * Qualifying volume for a competition window.
   *
   * Excluded trades are filtered rather than deleted, so the effect of the
   * anti-abuse rules stays auditable.
   */
  async traderVolume(args: {
    chainId: number;
    from: Date;
    to: Date;
    minTradeSize?: bigint;
  }) {
    return this.prisma.trade.groupBy({
      by: ["traderAddress"],
      where: {
        chainId: args.chainId,
        timestamp: { gte: args.from, lte: args.to },
        excludedFromCompetition: false,
        ...(args.minTradeSize !== undefined
          ? { quoteAmount: { gte: toDecimal(args.minTradeSize) } }
          : {}),
      },
      _sum: { quoteAmount: true },
      _count: { _all: true },
      orderBy: { _sum: { quoteAmount: "desc" } },
    });
  }

  private toCreateData(input: TradeInput): Prisma.TradeUncheckedCreateInput {
    return {
      chainId: input.chainId,
      transactionHash: input.transactionHash,
      logIndex: input.logIndex,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      tokenId: input.tokenId,
      curveAddress: input.curveAddress,
      venue: input.venue,
      traderAddress: input.traderAddress.toLowerCase(),
      recipientAddress: input.recipientAddress.toLowerCase(),
      side: input.side,
      tokenAmount: toDecimal(input.tokenAmount),
      quoteAmount: toDecimal(input.quoteAmount),
      feeAmount: toDecimal(input.feeAmount),
      creatorTaxAmount: toDecimal(input.creatorTaxAmount),
      snipeTaxAmount: toDecimal(input.snipeTaxAmount),
      refundAmount: toDecimal(input.refundAmount),
      price: toDecimal(input.price),
      marketCap: toDecimal(input.marketCap),
      timestamp: input.timestamp,
      excludedFromCompetition: input.excludedFromCompetition ?? false,
      ...(input.exclusionReason !== undefined
        ? { exclusionReason: input.exclusionReason }
        : {}),
    };
  }
}
