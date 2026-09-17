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

  // Resolve every curve in the window to its token in ONE query.
  //
  // This used to be one `findByCurve` per newly-seen curve. A window spanning hundreds
  // of active launches paid hundreds of sequential round trips before doing any work,
  // and it stalled the stream outright: one 126-block tick in six minutes while the
  // factory stream ran at ~100 blocks/second.
  const curveAddresses = logs.map((entry) => entry.address.toLowerCase());
  const tokenByCurve = await deps.repos.tokenBatch.findManyByCurves(
    deps.chainId,
    curveAddresses,
  );

  // Trades are collected and inserted together rather than one at a time. `recordMany`
  // uses createMany with skipDuplicates, so the unique constraint on
  // (chainId, transactionHash, logIndex) still makes a replay a no-op.
  const pendingTrades: Parameters<typeof deps.repos.trades.record>[0][] = [];
  const phaseSyncs: { tokenId: string; tokenAddress: string }[] = [];

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
      const token = tokenByCurve.get(raw.address.toLowerCase());
      if (token) {
        // The event says something changed; the chain says what it changed to. Deferred
        // to the end of the batch so it is not a sequential await inside the log loop.
        phaseSyncs.push({ tokenId: token.id, tokenAddress: token.address });
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

    pendingTrades.push({
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
    touched.add(token.id);
  }

  // ── One insert for the whole window ──
  if (pendingTrades.length > 0) {
    const inserted = await deps.repos.trades.recordMany(pendingTrades);
    trades = inserted.inserted;
    // Everything not inserted was already present. Counted rather than ignored, so a
    // persistent overlap is visible in the logs.
    duplicates = pendingTrades.length - inserted.inserted;
  }

  // Aggregates are recomputed from what is now stored, rather than incremented from
  // this batch. That way a replay cannot inflate them, and a rollback cannot leave
  // them stale.
  await refreshTokenStatsBatch([...touched], deps);

  for (const entry of phaseSyncs) {
    await syncPhaseFromChain(entry.tokenId, entry.tokenAddress, deps);
  }

  return { trades, duplicates, unmatched, tokensTouched: touched.size };
}

/**
 * Recompute derived stats for many tokens at once.
 *
 * The per-token version cost about six sequential round trips each — find the token,
 * three aggregates, a chain read, an update. At 100 tokens per window that was ~600
 * sequential round trips and the stream stalled.
 *
 * This does a fixed number of database queries regardless of token count, reads every
 * curve concurrently (Multicall3 collapses those), and then writes. The reserves and
 * graduation progress still come from the chain rather than from summing trades: fees
 * pending sweep are excluded from the curve's own reserve accounting, so a
 * reconstruction from trade history would drift.
 */
export async function refreshTokenStatsBatch(
  tokenIds: readonly string[],
  deps: CurveProcessorDeps,
): Promise<void> {
  if (tokenIds.length === 0) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [tokens, totals, daily, latest] = await Promise.all([
    deps.repos.tokenBatch.curveAddressesFor(tokenIds),
    deps.repos.tradeBatch.aggregateForTokens(tokenIds),
    deps.repos.tradeBatch.aggregateForTokens(tokenIds, { since }),
    deps.repos.tradeBatch.latestForTokens(tokenIds),
  ]);

  // Curve reads run concurrently. The indexer client has Multicall3 enabled, so these
  // collapse into batched calls rather than one request each.
  const states = await Promise.all(
    tokenIds.map(async (tokenId) => {
      const token = tokens.get(tokenId);
      if (!token) return { tokenId, state: null };
      try {
        return {
          tokenId,
          state: await readCurveState(deps.client, token.curveAddress as Address),
        };
      } catch {
        // A graduated curve can stop answering some reads. Keeping the last known
        // values is honest; fabricating a reserve would not be.
        return { tokenId, state: null };
      }
    }),
  );
  const stateByToken = new Map(states.map((entry) => [entry.tokenId, entry.state]));

  // One set-based write for every touched token. The earlier bounded worker approach
  // prevented pool exhaustion but still paid one network round trip per token; on Neon
  // that kept the curve stream below the chain's 10 blocks/second. `updateStatsMany`
  // preserves the same derived-field boundary as TokenRepository.updateStats, but sends
  // all values in one PostgreSQL statement.
  const statsRows: {
    tokenId: string;
    stats: Parameters<typeof deps.repos.tokens.updateStats>[1];
  }[] = [];
  for (const tokenId of tokenIds) {
    const token = tokens.get(tokenId);
    if (!token) continue;

    const aggregate = totals.get(tokenId) ?? {
      volume: 0n,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
    };
    const dayAggregate = daily.get(tokenId) ?? {
      volume: 0n,
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
    };
    const lastTrade = latest.get(tokenId);
    const state = stateByToken.get(tokenId) ?? null;

    let realQuoteReserve = 0n;
    let graduationBps = 0;
    if (state) {
      realQuoteReserve = state.realQuoteReserve;
      // eslint-disable-next-line no-restricted-syntax -- basis points 0..10000 stored in an int column, not a money value
      graduationBps = Number(ratioBps(state.realQuoteReserve, state.graduationThreshold));
      if (graduationBps > 10_000) graduationBps = 10_000;
    }

    const price = lastTrade ? lastTrade.price : 0n;
    statsRows.push({
      tokenId,
      stats: {
        realQuoteReserve,
        graduationBps,
        price,
        marketCap: marketCapFromPrice(price, token.totalSupply),
        volume24h: dayAggregate.volume,
        volumeTotal: aggregate.volume,
        // Carried through unchanged, NOT computed. Deriving a holder count needs the
        // ERC-20 Transfer stream, which is not indexed yet: trades alone cannot see a
        // wallet-to-wallet move, so counting them would undercount by an unknown
        // amount. The column therefore stays at its initial 0 and the UI says "not
        // indexed yet" rather than printing that 0 as if it were a measurement.
        holderCount: token.holderCount,
        tradeCount: aggregate.tradeCount,
        buyCount: aggregate.buyCount,
        sellCount: aggregate.sellCount,
        ...(lastTrade ? { lastTradeAt: lastTrade.timestamp } : {}),
      },
    });
  }
  await deps.repos.tokenBatch.updateStatsMany(statsRows);
}

/**
 * Single-token stats refresh. Retained because the graduation stream and the recovery
 * paths refresh one token at a time, where batching would add nothing.
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
    // Carried through unchanged, not computed. See the note in the batch path above.
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
