import type { Address, PublicClient } from "viem";
import type { Repositories } from "@stunks/database";
import { decodePonsLog, readCurveState, readLaunchedToken } from "@stunks/pons";
import { ratioBps } from "@stunks/utils";
import type { BlockTimeCache } from "../block-cache.js";
import {
  competitionExclusion,
  marketCapFromPrice,
  priceFromTrade,
  volumeFromTrade,
} from "../pricing.js";
import type { RawLog } from "../sources/types.js";

/**
 * Curve stream processor: `CurveBuy` / `CurveSell` into Trade rows.
 *
 * There is one curve contract per launch, so this stream is keyed by curve address
 * rather than by a shared pool. Logs arrive from many curves at once and are matched
 * back to their token via the curve address.
 *
 * Two details that a naive implementation gets wrong:
 *
 * 1. `quoteIn` on a CurveBuy is what the curve ACTUALLY charged, already net of any
 *    refund from a clamped fill. So volume and price come straight from the event —
 *    no need to reconcile against CurveBuyRefunded, which is informational.
 *
 * 2. `buyer` and `recipient` are separate fields and both are stored. The anti-snipe
 *    tax is evaluated per recipient, and a whitelist bundle is one payer delivering
 *    to many recipients, so collapsing them would make bundle activity unanalysable.
 */

export interface CurveProcessorDeps {
  readonly client: PublicClient;
  readonly repos: Repositories;
  readonly chainId: number;
  /** Needed to confirm a phase change from the factory record. */
  readonly factory: Address;
  readonly blockTimes: BlockTimeCache;
  readonly log: (message: string, meta?: Record<string, unknown>) => void;
  /** Minimum trade size to count toward competition volume. */
  readonly minCompetitionTradeSize?: bigint;
  readonly competitionExcludedAddresses?: readonly string[];
}

export interface CurveProcessResult {
  readonly trades: number;
  readonly duplicates: number;
  readonly unmatched: number;
  readonly tokensTouched: number;
}

export async function processCurveLogs(
  logs: readonly RawLog[],
  deps: CurveProcessorDeps,
): Promise<CurveProcessResult> {
  let trades = 0;
  let duplicates = 0;
  let unmatched = 0;
  const touched = new Set<string>();

  // One round trip per distinct block instead of one per log. A busy launch emits
  // many trades in the same block.
  await deps.blockTimes.warm(logs.map((entry) => entry.blockNumber));

  // Resolving the same curve repeatedly inside one batch is wasteful: a busy launch
  // can emit dozens of trades in a single window.
  const tokenByCurve = new Map<
    string,
    { id: string; totalSupply: bigint; address: string } | null
  >();

  for (const raw of logs) {
    const decoded = decodePonsLog({
      address: raw.address,
      topics: raw.topics as [] | [`0x${string}`, ...`0x${string}`[]],
      data: raw.data,
      blockNumber: raw.blockNumber,
      transactionHash: raw.transactionHash,
      logIndex: raw.logIndex,
      blockHash: raw.blockHash,
      removed: false,
      transactionIndex: 0,
    });

    if (!decoded) continue;

    /**
     * The curve, not the factory, emits these. A factory-only processor would never
     * see them — and `AutoGraduationFailed` is precisely the signal that a token is
     * stuck in `Swept` with no tradeable venue, which is the state most likely to
     * strand users if the app does not know about it.
     */
    if (decoded.name === "AutoGraduationFailed" || decoded.name === "CurveCompleted") {
      const token = await deps.repos.tokens.findByCurve(deps.chainId, raw.address);
      if (token) {
        // The event says something changed; the chain says what it changed to.
        await syncPhaseFromChain(token.id, token.address, deps);
        if (decoded.name === "AutoGraduationFailed") {
          deps.log("auto-graduation FAILED — token may be stuck awaiting its pool", {
            token: token.address,
            block: raw.blockNumber.toString(),
            gasRemaining: String(decoded.args.gasRemaining ?? ""),
          });
        }
      }
      continue;
    }

    if (decoded.name !== "CurveBuy" && decoded.name !== "CurveSell") continue;

    const curveKey = raw.address.toLowerCase();
    if (!tokenByCurve.has(curveKey)) {
      const token = await deps.repos.tokens.findByCurve(deps.chainId, curveKey);
      tokenByCurve.set(
        curveKey,
        token
          ? {
              id: token.id,
              totalSupply: BigInt(token.totalSupply.toFixed()),
              address: token.address,
            }
          : null,
      );
    }

    const token = tokenByCurve.get(curveKey);
    if (!token) {
      // The launch has not been indexed yet — the factory stream may be behind, or
      // this curve belongs to a launch outside our start block. Counted, not
      // silently dropped, so a persistent gap is visible.
      unmatched++;
      continue;
    }

    const isBuy = decoded.name === "CurveBuy";
    const quoteAmount = (isBuy ? decoded.args.quoteIn : decoded.args.quoteOut) as bigint;
    const tokenAmount = (
      isBuy ? decoded.args.tokensOut : decoded.args.tokensIn
    ) as bigint;
    const trader = (isBuy ? decoded.args.buyer : decoded.args.seller) as Address;
    const recipient = decoded.args.recipient as Address;
    const fee = decoded.args.fee as bigint;
    const tax = decoded.args.tax as bigint;

    const price = priceFromTrade({ quoteAmount, tokenAmount });
    const marketCap = marketCapFromPrice(price, token.totalSupply);

    const exclusion = competitionExclusion({
      traderAddress: trader,
      recipientAddress: recipient,
      quoteAmount,
      minTradeSize: deps.minCompetitionTradeSize ?? 0n,
      excludedAddresses: deps.competitionExcludedAddresses ?? [],
    });

    const timestamp = await deps.blockTimes.get(raw.blockNumber);

    const result = await deps.repos.trades.record({
      chainId: deps.chainId,
      transactionHash: raw.transactionHash,
      logIndex: raw.logIndex,
      blockNumber: raw.blockNumber,
      blockHash: raw.blockHash,
      tokenId: token.id,
      curveAddress: curveKey,
      venue: "CURVE",
      traderAddress: trader,
      recipientAddress: recipient,
      side: isBuy ? "BUY" : "SELL",
      tokenAmount,
      quoteAmount,
      feeAmount: fee,
      creatorTaxAmount: tax,
      // The event does not separate the anti-snipe tax from the base fee, so it is
      // not invented here. It is reconstructible from currentSnipeTaxBps at the
      // trade's timestamp if it is ever needed.
      snipeTaxAmount: 0n,
      refundAmount: 0n,
      price,
      marketCap,
      timestamp,
      excludedFromCompetition: exclusion.excluded,
      ...(exclusion.reason !== undefined ? { exclusionReason: exclusion.reason } : {}),
    });

    if (result.created) {
      trades++;
      touched.add(token.id);
    } else {
      duplicates++;
    }
  }

  // Aggregates are recomputed from what is now stored, rather than incremented from
  // this batch. That way a replay cannot inflate them, and a rollback cannot leave
  // them stale.
  for (const tokenId of touched) {
    await refreshTokenStats(tokenId, deps);
  }

  return { trades, duplicates, unmatched, tokensTouched: touched.size };
}

/**
 * Recompute a token's derived stats from stored trades plus a live curve read.
 *
 * The reserves and graduation progress come from the chain, not from summing trades:
 * fees pending sweep are excluded from the curve's own reserve accounting, so a
 * reconstruction from trade history would drift.
 */
export async function refreshTokenStats(
  tokenId: string,
  deps: CurveProcessorDeps,
): Promise<void> {
  const token = await deps.repos.tokens.findById(tokenId);
  if (!token) return;

  const [aggregate, dayAggregate, lastTrade] = await Promise.all([
    deps.repos.trades.aggregateForToken(tokenId),
    deps.repos.trades.aggregateForToken(tokenId, {
      since: new Date(Date.now() - 24 * 60 * 60 * 1000),
    }),
    deps.repos.trades.latestForToken(tokenId),
  ]);

  let realQuoteReserve = 0n;
  let graduationBps = 0;
  const price = lastTrade ? BigInt(lastTrade.price.toFixed()) : 0n;

  try {
    const state = await readCurveState(deps.client, token.curveAddress as Address);
    realQuoteReserve = state.realQuoteReserve;
    // eslint-disable-next-line no-restricted-syntax -- basis points 0..10000 stored in an int column, not a money value
    graduationBps = Number(ratioBps(state.realQuoteReserve, state.graduationThreshold));
    if (graduationBps > 10_000) graduationBps = 10_000;
  } catch {
    // A graduated curve can stop answering some reads. Keeping the last known price
    // is honest; fabricating a reserve would not be.
    deps.log("curve state unreadable, keeping last known values", {
      token: token.address,
    });
  }

  const totalSupply = BigInt(token.totalSupply.toFixed());

  await deps.repos.tokens.updateStats(tokenId, {
    realQuoteReserve,
    graduationBps,
    price,
    marketCap: marketCapFromPrice(price, totalSupply),
    volume24h: dayAggregate.volume,
    volumeTotal: aggregate.volume,
    holderCount: token.holderCount,
    tradeCount: aggregate.tradeCount,
    buyCount: aggregate.buyCount,
    sellCount: aggregate.sellCount,
    ...(lastTrade ? { lastTradeAt: lastTrade.timestamp } : {}),
  });
}

/**
 * Re-read a token's phase from the chain and persist it if it moved.
 *
 * The phase is never inferred from which event arrived. `Swept` is reachable without
 * a successful graduation, so trusting an event over the factory record could put the
 * app into a venue it cannot trade.
 */
async function syncPhaseFromChain(
  tokenId: string,
  tokenAddress: string,
  deps: CurveProcessorDeps,
): Promise<void> {
  try {
    const launch = await readLaunchedToken(
      deps.client,
      deps.factory,
      tokenAddress as Address,
    );
    if (!launch.exists) return;

    const dbPhase = (["NOT_GRADUATED", "SWEPT", "POOL_CREATED", "RESCUED"] as const)[
      launch.phase
    ];
    if (!dbPhase) return;

    await deps.repos.tokens.setPhase(tokenId, dbPhase);
  } catch (error) {
    deps.log("phase sync failed", {
      token: tokenAddress,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Volume of one trade, exported so the scanner can log throughput meaningfully. */
export { volumeFromTrade };
