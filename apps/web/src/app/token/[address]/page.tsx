import type { Metadata } from "next";
import { isAddress, type Address } from "viem";
import { KNOWN_RPC_ENDPOINTS, ROBINHOOD_CHAIN_ID } from "@stunks/config";
import { createReadClient } from "@stunks/web3";
import {
  computeGraduationProgress,
  describeNoVenue,
  describePhase,
  orderPoolCurrencies,
  parseGraduationPhase,
  readCurveState,
  readLaunchedToken,
  resolvePonsAddresses,
  resolveTradingVenue,
} from "@stunks/pons";
import {
  formatBps,
  formatCompact,
  formatPrice,
  formatProgress,
  formatRelativeTime,
  formatUnitsExact,
  shortAddress,
} from "@stunks/utils";
import { getChainContracts } from "@stunks/config";
import { tokenDetail, tokenHolders, tokenTrades } from "@/lib/queries";
import { TokenAvatar } from "@/components/token-avatar";
import { TokenLinks } from "@/components/token-links";
import { TradePanel } from "./trade-panel";

/**
 * Token page.
 *
 * The most important line in this file is the live `readLaunchedToken` call. Indexed
 * data supplies history — trades, holders, aggregates — but the token's PHASE and
 * therefore its trading venue come from a fresh on-chain read every request.
 *
 * That is not caution for its own sake. `SWEPT` is a reachable state where the curve
 * has been drained and the Uniswap pool does not exist yet, and the indexer can lag by
 * minutes. A page that trusted the database for phase would offer trades that always
 * revert, which is the single most likely correctness bug in a trading UI built on this
 * protocol.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

function endpoints(): string[] {
  const configured = process.env.NEXT_PUBLIC_RPC_ENDPOINTS ?? process.env.RPC_ENDPOINTS;
  if (configured) {
    return configured
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [KNOWN_RPC_ENDPOINTS.drpc];
}

interface PageProps {
  readonly params: Promise<{ address: string }>;
}

/**
 * Prefix a symbol with `$` unless it already carries one.
 *
 * Many launches on this chain name themselves `$RACK` rather than `RACK`, and blindly
 * prefixing produced `$$RACK` in headings and page titles.
 */
function withDollar(symbol: string): string {
  return symbol.startsWith("$") ? symbol : `$${symbol}`;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { address } = await params;
  if (!isAddress(address)) return { title: "Token not found — STUNKS.FUN" };

  const token = await tokenDetail(address);
  if (!token) return { title: "Token not found — STUNKS.FUN" };

  const cap = formatCompact(token.marketCap, token.pairTokenDecimals);
  const volume = formatCompact(token.volume24h, token.pairTokenDecimals);

  return {
    title: `${withDollar(token.symbol)} — Trade on STUNKS.FUN`,
    description:
      `${token.name} on Robinhood Chain. Market cap ${cap}, 24h volume ${volume}. ` +
      `Launched through Pons V2.`,
    openGraph: {
      title: `${withDollar(token.symbol)} — ${token.name}`,
      description: `Market cap ${cap} · Volume ${volume} · STUNKS.FUN`,
    },
  };
}

export default async function TokenPage({ params }: PageProps) {
  const { address } = await params;

  // An address from a URL is untrusted input.
  if (!isAddress(address)) {
    return (
      <main className="token-page">
        <h1>Invalid address</h1>
        <p>That is not a valid EVM address.</p>
        <p>
          <a href="/explore">Back to explore</a>
        </p>
      </main>
    );
  }

  const token = await tokenDetail(address);

  // ── Live on-chain read. This decides whether trading is offered at all. ──
  let live: {
    exists: boolean;
    phase: number;
    curve: Address;
    pairToken: Address;
    realQuoteReserve: bigint;
    graduationThreshold: bigint;
    sellableTokens: bigint;
    feeBps: bigint;
    creatorTaxBps: bigint;
    venueKind: string;
    venueReason?: string;
  } | null = null;
  let liveError: string | null = null;

  try {
    const { client } = createReadClient(endpoints());
    const factory = getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2Factory;
    const launch = await readLaunchedToken(client, factory, address);

    if (launch.exists) {
      const addresses = await resolvePonsAddresses(client, factory);
      const curveState = await readCurveState(client, launch.curve).catch(() => null);

      const venue = resolveTradingVenue({
        launch,
        poolManager: addresses.poolManager,
        memeHook: addresses.memeHook,
        ...(token?.pool
          ? {
              poolCurrencies: orderPoolCurrencies(
                token.pool.currency0 as Address,
                token.pool.currency1 as Address,
              ),
            }
          : {}),
      });

      live = {
        exists: true,
        phase: launch.phase,
        curve: launch.curve,
        pairToken: launch.pairToken,
        realQuoteReserve: curveState?.realQuoteReserve ?? 0n,
        graduationThreshold: launch.graduationThreshold,
        sellableTokens: curveState?.sellableTokens ?? 0n,
        feeBps: curveState?.feeBps ?? 0n,
        creatorTaxBps: BigInt(launch.creatorTaxBps),
        venueKind: venue.kind,
        ...(venue.kind === "NONE" ? { venueReason: venue.reason } : {}),
      };
    } else {
      live = {
        exists: false,
        phase: 0,
        curve: address,
        pairToken: address,
        realQuoteReserve: 0n,
        graduationThreshold: 0n,
        sellableTokens: 0n,
        feeBps: 0n,
        creatorTaxBps: 0n,
        venueKind: "NONE",
        venueReason: "NOT_A_PONS_LAUNCH",
      };
    }
  } catch (error) {
    liveError = error instanceof Error ? error.message : String(error);
  }

  // Not a Pons launch: refuse to render a trading surface at all. This is what stops
  // STUNKS becoming a trading UI for an arbitrary contract that merely looks like one.
  if (live?.exists === false) {
    return (
      <main className="token-page">
        <h1>Not a Pons V2 launch</h1>
        <div className="error">
          <p style={{ color: "var(--text)" }}>
            <span className="mono">{address}</span> is not registered with the Pons V2
            factory, so STUNKS will not present it as tradeable.
          </p>
          <p style={{ margin: 0 }}>
            It may be an unrelated contract, a Pons V1 token, or nothing at all.
          </p>
        </div>
        <p>
          <a href="/explore">Back to explore</a>
        </p>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="token-page">
        <h1>Not indexed yet</h1>
        <p>
          {live
            ? "This is a real Pons V2 launch, but STUNKS has not indexed it yet. " +
              "History and statistics will appear once the indexer reaches its launch block."
            : "This token has not been indexed, and the chain could not be reached to " +
              "confirm whether it exists."}
        </p>
        <p className="mono hint">{address}</p>
        <p>
          <a href="/explore">Back to explore</a>
        </p>
      </main>
    );
  }

  const [trades, holders] = await Promise.all([
    tokenTrades(token.id, 30),
    tokenHolders(token.id, 10),
  ]);

  const quoteDecimals = token.pairTokenDecimals;
  const isNative = /^0x0{40}$/i.test(token.pairTokenAddress);
  const quoteSymbol = isNative ? "ETH" : "quote";

  // Progress from the LIVE reserve where available, falling back to indexed state.
  const progress = live
    ? computeGraduationProgress({
        realQuoteReserve: live.realQuoteReserve,
        graduationThreshold: live.graduationThreshold,
        sellableTokens: live.sellableTokens,
        phase: parseGraduationPhase(live.phase),
      })
    : null;

  return (
    <main className="token-page">
      <div className="tokenhead">
        <div className="token-identity">
          <TokenAvatar
            symbol={token.symbol}
            imageUrl={token.imageUrl}
            className="token-avatar-lg"
          />
          <div>
            <p className="page-kicker">Live Pons V2 launch</p>
            <h1>{withDollar(token.symbol)}</h1>
            <p className="token-subtitle">{token.name}</p>
          </div>
        </div>
        <div className="tokenhead-stats">
          <Stat
            label="Price"
            value={`${formatPrice(token.price, quoteDecimals, 4, token.decimals)} ${quoteSymbol}`}
          />
          <Stat
            label="Market cap"
            value={`${formatCompact(token.marketCap, quoteDecimals)} ${quoteSymbol}`}
          />
          <Stat
            label="Volume 24h"
            value={`${formatCompact(token.volume24h, quoteDecimals)} ${quoteSymbol}`}
          />
        </div>
      </div>

      <TokenLinks
        description={token.description}
        websiteUrl={token.websiteUrl}
        twitterUrl={token.twitterUrl}
        telegramUrl={token.telegramUrl}
        discordUrl={token.discordUrl}
        farcasterUrl={token.farcasterUrl}
      />

      <section className="token-trade-section">
        <div className="section-heading">
          <div>
            <p className="page-kicker">Live trading venue</p>
            <h2>Trade {withDollar(token.symbol)}</h2>
          </div>
          {live && live.venueKind === "CURVE" && (
            <span className="badge ok">Pons curve</span>
          )}
        </div>
        {liveError !== null ? (
          <div className="error">
            <p style={{ color: "var(--text)", margin: 0 }}>
              The chain could not be reached, so STUNKS cannot confirm whether this token
              is tradeable right now. Trading is disabled rather than guessed.
            </p>
            <p className="mono hint">{liveError}</p>
          </div>
        ) : live && live.venueKind === "CURVE" ? (
          <div className="token-trade-grid">
            <div className="panel pad token-trade-summary">
              <span className="surface-label">Verified curve route</span>
              <p className="hint" style={{ marginTop: 10 }}>
                Tradeable on its Pons bonding curve. Total fee per trade:{" "}
                <span className="mono">
                  {formatBps(live.feeBps + live.creatorTaxBps)}
                </span>{" "}
                ({formatBps(live.feeBps)} curve + {formatBps(live.creatorTaxBps)}{" "}
                creator). STUNKS adds nothing on top.
              </p>
              <div className="trade-summary-points">
                <span>✓ Fresh quote before signing</span>
                <span>✓ On-chain minimum received</span>
                <span>✓ Non-custodial wallet flow</span>
              </div>
            </div>
            <TradePanel
              token={token.address as Address}
              factory={getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2Factory}
              symbol={withDollar(token.symbol)}
              tokenDecimals={token.decimals}
              quoteDecimals={quoteDecimals}
              quoteSymbol={quoteSymbol}
              quoteIsNative={isNative}
              quoteTokenAddress={token.pairTokenAddress as Address}
            />
          </div>
        ) : live && live.venueKind === "UNISWAP_V4" ? (
          <div className="panel pad">
            <p className="hint" style={{ margin: 0 }}>
              Graduated. Trading happens in a Uniswap V4 pool governed by the Pons meme
              hook. STUNKS does not yet route V4 swaps — the quoting path for V4 is not
              verified, and guessing it would misprice trades.
            </p>
          </div>
        ) : (
          <div className="error">
            <p style={{ color: "var(--text)", margin: 0 }}>
              {live?.venueReason
                ? describeNoVenue(live.venueReason as never)
                : "Trading is unavailable for this token right now."}
            </p>
          </div>
        )}
      </section>

      {progress && live && live.phase === 0 && (
        <>
          <h2>Graduation</h2>
          <div className="panel pad">
            <div className="progress">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    // eslint-disable-next-line no-restricted-syntax -- bps 0..10000 becoming a CSS width; not an amount
                    width: `${Math.min(100, Number(progress.progressBps) / 100)}%`,
                  }}
                />
              </div>
              <span className="card-label">
                {/* eslint-disable-next-line no-restricted-syntax -- bps 0..10000 for display; not an amount */}
                {formatProgress(Number(progress.progressBps))} —{" "}
                {formatUnitsExact(progress.realQuoteReserve, quoteDecimals)} of{" "}
                {formatUnitsExact(progress.graduationThreshold, quoteDecimals)}{" "}
                {quoteSymbol}
              </span>
            </div>
            <p className="hint" style={{ marginBottom: 0 }}>
              Read live from the curve. Graduation actually triggers when the curve&apos;s
              sellable allocation reaches zero, which is the same point expressed from the
              token side.
              {progress.readyToGraduate &&
                " This curve is ready to graduate — the next step is permissionless."}
            </p>
          </div>
        </>
      )}

      <h2>Token</h2>
      <div className="panel">
        <table>
          <tbody>
            <Row label="Contract" value={token.address} mono />
            <Row label="Curve" value={token.curveAddress} mono />
            <Row
              label="Phase (live)"
              value={live ? describePhase(parseGraduationPhase(live.phase)) : "unknown"}
            />
            <Row label="Creator" value={token.creatorAddress} mono />
            <Row
              label="Quote asset"
              value={
                isNative
                  ? "Native ETH"
                  : `${token.pairTokenAddress} (${quoteDecimals} dp)`
              }
              mono={!isNative}
            />
            <Row label="Creator tax" value={formatBps(token.creatorTaxBps)} />
            <Row
              label="Total supply"
              value={formatUnitsExact(token.totalSupply, token.decimals)}
            />
            {/*
              Not indexed, so not shown as a number.

              Nothing writes the holders table: the curve processor carries the token's
              existing `holderCount` straight back into its own update, so the column is
              permanently 0. Rendering that 0 stated a fact nobody had measured, in the
              one place on the page a reader would take it for one — while the holders
              table further down correctly said it was not indexed yet. Invariant 4 does
              not have an exception for a value that merely looks plausible.
            */}
            <Row label="Holders" value="Not indexed yet" />
            <Row
              label="Trades"
              value={`${token.tradeCount} (${token.buyCount} buys, ${token.sellCount} sells)`}
            />
            <Row label="Launch block" value={token.launchBlock.toString()} mono />
            {token.hadWhitelistBundle && (
              <Row
                label="Whitelist bundle"
                value={`${token.whitelistSize} address(es) were exempted from the anti-snipe tax at launch`}
              />
            )}
          </tbody>
        </table>
      </div>

      <h2>Trades</h2>
      {trades.items.length === 0 ? (
        <div className="panel pad">
          <p className="hint" style={{ margin: 0 }}>
            No trades indexed for this token yet. Either it has not traded, or the indexer
            has not reached its trades — nothing is invented to fill this space.
          </p>
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Side</th>
                <th>Trader</th>
                <th>Amount</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {trades.items.map((trade) => (
                <tr key={trade.id}>
                  <td className="source">{formatRelativeTime(trade.timestamp)}</td>
                  <td>
                    <span className={`badge ${trade.side === "BUY" ? "ok" : "warn"}`}>
                      {trade.side}
                    </span>
                  </td>
                  <td className="value">
                    {shortAddress(trade.traderAddress)}
                    {trade.traderAddress.toLowerCase() !==
                      trade.recipientAddress.toLowerCase() && (
                      <span className="hint">
                        {" "}
                        → {shortAddress(trade.recipientAddress)}
                      </span>
                    )}
                  </td>
                  <td className="value">
                    {formatCompact(trade.quoteAmount, quoteDecimals)} {quoteSymbol}
                  </td>
                  <td className="value">
                    {formatPrice(trade.price, quoteDecimals, 4, token.decimals)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Holders</h2>
      {holders.length === 0 ? (
        <div className="panel pad">
          <p className="hint" style={{ margin: 0 }}>
            Holder balances are not indexed yet. Token transfer indexing arrives with the
            holder stream; until then this is left blank rather than estimated from
            trades.
          </p>
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {holders.map((holder) => (
                <tr key={holder.walletAddress}>
                  <td className="value">{shortAddress(holder.walletAddress)}</td>
                  <td className="value">
                    {formatCompact(holder.balance, token.decimals)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: 28 }}>
        <a href="/explore">Back to explore</a>
      </p>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="card-label">{label}</span>
      <span className="stat-value mono">{value}</span>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className={mono === true ? "value" : ""}>{value}</td>
    </tr>
  );
}
