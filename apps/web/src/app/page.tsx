import Image from "next/image";
import Link from "next/link";
import {
  formatBps,
  formatBlockLag,
  formatCompact,
  formatUnitsExact,
  ratioBps,
  shortAddress,
} from "@stunks/utils";
import { BLOCK_TIME_SECONDS, BLOCKS_PER_DAY } from "@stunks/config";
import { readChainSnapshot } from "@/lib/read-chain";
import heroBackdrop from "../../../../Asset/banner-stunks.png";
import heroLogo from "../../../../Asset/logo-transparent.png";
import { exploreTokens, platformStats } from "@/lib/queries";

/**
 * STUNKS landing page.
 *
 * The visual layer is intentionally new, but its facts are not. Hero metrics come from
 * the indexed database and are clearly marked as indexed; protocol parameters, head,
 * and fee policy still come from a fresh Pons V2 read. If either source fails, the page
 * says so rather than filling the premium surface with plausible invented numbers.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

function bpsToPercent(bps: bigint | number): string {
  return formatBps(bps);
}

interface TelemetryRow {
  readonly label: string;
  readonly value: string;
  readonly source: string;
}

function TelemetryTable({ rows }: { rows: readonly TelemetryRow[] }) {
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Value</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td className="value">{row.value}</td>
              <td className="source">{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function Page() {
  const snapshot = await readChainSnapshot();
  const chainHead = snapshot.ok ? snapshot.blockNumber : null;

  let indexed: {
    readonly stats: Awaited<ReturnType<typeof platformStats>>;
    readonly trending: Awaited<ReturnType<typeof exploreTokens>>;
  } | null = null;
  let indexError: string | null = null;

  try {
    const [stats, trending] = await Promise.all([
      platformStats(),
      exploreTokens({ sort: "TRENDING", limit: 5, chainHead }),
    ]);
    indexed = { stats, trending };
  } catch (error) {
    indexError = error instanceof Error ? error.message : String(error);
  }

  const snapshotError = snapshot.ok ? null : snapshot;
  const telemetry = snapshot.ok
    ? {
        chain: [
          {
            label: "Chain",
            value: `Robinhood Chain (${snapshot.chainId})`,
            source: "eth_chainId",
          },
          {
            label: "Head block",
            value: snapshot.blockNumber.toString(),
            source: "eth_getBlockByNumber",
          },
          {
            label: "Block time",
            value: `~${BLOCK_TIME_SECONDS}s · ${BLOCKS_PER_DAY.toLocaleString("en-US")} blocks/day`,
            source: "Phase 0 measurement",
          },
          { label: "RPC", value: snapshot.endpoint, source: "configuration" },
          {
            // Stated rather than implied: the head above is this request, the protocol
            // values below may be up to a minute old. Saying so is the whole reason
            // the cache is allowed to exist.
            label: "Protocol read",
            value: snapshot.protocolReadAt,
            source: "cached up to 60s",
          },
        ] satisfies readonly TelemetryRow[],
        protocol: [
          {
            label: "Launch fee",
            value: `${formatUnitsExact(snapshot.parameters.launchFee, 18)} ETH`,
            source: "factory.launchFee()",
          },
          {
            label: "Max creator tax",
            value: bpsToPercent(snapshot.parameters.maxCreatorTaxBps),
            source: "factory.maxCreatorTaxBps()",
          },
          {
            label: "Anti-snipe window",
            value: `${snapshot.parameters.snipeTaxSeconds}s`,
            source: "factory.snipeTaxSeconds()",
          },
          {
            label: "STUNKS platform revenue",
            value: `${snapshot.platformRevenue.amount} — none`,
            source: "verified fee routing",
          },
          {
            label: "Factory",
            value: shortAddress(snapshot.addresses.factory),
            source: "configuration",
          },
          {
            label: "Meme hook / fee policy",
            value: shortAddress(snapshot.addresses.memeHook),
            source: "factory.memeHook()",
          },
        ] satisfies readonly TelemetryRow[],
      }
    : null;

  const activeConfig = snapshot.ok
    ? snapshot.configs.find((config) => config.enabled)
    : null;
  const reserved =
    snapshot.ok && activeConfig
      ? (snapshot.reservedTokensByConfig[snapshot.configs.indexOf(activeConfig)] ?? 0n)
      : null;
  const reservedBps =
    activeConfig && reserved !== null ? ratioBps(reserved, activeConfig.supply) : null;

  return (
    <main className="home-main">
      <section className="home-hero">
        <Image src={heroBackdrop} alt="" fill sizes="100vw" className="hero-backdrop" />
        <div className="home-hero-inner">
          <div className="hero-copy">
            <p className="hero-eyebrow">Robinhood Chain · Pons V2</p>
            <h1 className="hero-title">
              Launch. Trade.
              <em>Grow Together.</em>
            </h1>
            <p>
              A non-custodial launchpad and curve-trading interface for real Pons V2
              launches. No private keys, no synthetic market data, and no STUNKS platform
              fee.
            </p>
            <div className="hero-actions">
              <Link href="/explore" className="btn btn-primary">
                Explore tokens <span className="hero-action-arrow">→</span>
              </Link>
              <Link href="/launch" className="btn">
                Launch token <span className="hero-action-arrow">↗</span>
              </Link>
            </div>
          </div>

          <div className="hero-visual" aria-hidden="true">
            <Image
              src={heroLogo}
              alt=""
              priority
              sizes="(max-width: 820px) 265px, 430px"
              className="hero-logo"
            />
          </div>

          <aside className="hero-rail" aria-label="Indexed platform statistics">
            <div className="hero-metric-card">
              <span className="surface-label">Indexed trade activity</span>
              <div className="hero-metric-value">
                {indexed ? indexed.stats.tradeCount.toLocaleString("en-US") : "—"}
                <small>{indexed ? "real events" : "unavailable"}</small>
              </div>
              {indexed ? (
                <>
                  <div className="hero-mini-stats">
                    <div>
                      <span className="card-label">Tokens</span>
                      <strong>{indexed.stats.tokenCount.toLocaleString("en-US")}</strong>
                    </div>
                    <div>
                      <span className="card-label">Creators</span>
                      <strong>
                        {indexed.stats.creatorCount.toLocaleString("en-US")}
                      </strong>
                    </div>
                    <div>
                      <span className="card-label">Graduated</span>
                      <strong>
                        {indexed.stats.graduatedCount.toLocaleString("en-US")}
                      </strong>
                    </div>
                  </div>
                  <div
                    className={
                      indexed.trending.staleness.isStale
                        ? "hero-freshness stale"
                        : "hero-freshness"
                    }
                  >
                    <span>{indexed.trending.staleness.isStale ? "!" : "✓"}</span>
                    <p>
                      {indexed.trending.staleness.lagBlocks !== null
                        ? `Indexed to ${indexed.trending.staleness.indexedBlock} — ${formatBlockLag(
                            BigInt(indexed.trending.staleness.lagBlocks),
                            BLOCK_TIME_SECONDS,
                          )}${indexed.trending.staleness.isStale ? " behind chain" : " current"}${
                            indexed.trending.staleness.stream !== null
                              ? ` (${indexed.trending.staleness.stream} stream)`
                              : ""
                          }`
                        : "Live chain unavailable — indexed figures only"}
                    </p>
                  </div>
                </>
              ) : (
                <p className="hint">Indexed market data is unavailable right now.</p>
              )}
            </div>

            <div className="hero-competition-card">
              <span className="hero-competition-icon">✦</span>
              <div>
                <strong>Zero STUNKS fee</strong>
                <p>Route directly to verified Pons V2 curve contracts.</p>
              </div>
              <span className="hero-competition-arrow">→</span>
            </div>
          </aside>
        </div>
      </section>

      <div className="home-content">
        <section className="feature-grid" aria-label="STUNKS capabilities">
          <article className="panel feature-card">
            <span className="feature-icon">↗</span>
            <h3>Launch</h3>
            <p>Create through live Pons V2 terms. STUNKS never takes custody.</p>
            <Link href="/launch">Open launch flow →</Link>
          </article>
          <article className="panel feature-card">
            <span className="feature-icon">⇄</span>
            <h3>Trade</h3>
            <p>
              Get a fresh curve quote, real min-out protection, and explicit approvals.
            </p>
            <Link href="/explore">Find a curve token →</Link>
          </article>
          <article className="panel feature-card">
            <span className="feature-icon">⌕</span>
            <h3>Explore</h3>
            <p>Discover indexed launches, activity, graduation progress, and history.</p>
            <Link href="/explore">Browse the market →</Link>
          </article>
          <article className="panel feature-card">
            <span className="feature-icon">◈</span>
            <h3>Protected launch</h3>
            <p>
              Use the verified 31-address exemption cap with honest anti-snipe disclosure.
            </p>
            <Link href="/launch">Set up protection →</Link>
          </article>
        </section>

        <section className="home-grid" style={{ marginTop: 16 }}>
          <div className="home-section-card">
            <div className="home-section-header">
              <h2>Trending tokens</h2>
              <Link href="/explore?sort=TRENDING">View all →</Link>
            </div>
            {indexed && indexed.trending.tokens.length > 0 ? (
              <table className="home-token-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Token</th>
                    <th>Market cap</th>
                    <th>Volume 24h</th>
                    <th>Trades</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {indexed.trending.tokens.map((token, index) => (
                    <tr key={token.address}>
                      <td className="source">{index + 1}</td>
                      <td>
                        <div className="home-token-cell">
                          <span className="token-avatar">
                            {token.symbol.slice(0, 2).toUpperCase()}
                          </span>
                          <span>
                            <span className="home-token-symbol">{token.symbol}</span>
                            <span className="home-token-name">{token.name}</span>
                          </span>
                        </div>
                      </td>
                      <td className="value">
                        {formatCompact(BigInt(token.marketCap), token.pairTokenDecimals)}
                      </td>
                      <td className="value">
                        {formatCompact(BigInt(token.volume24h), token.pairTokenDecimals)}
                      </td>
                      <td className="value">
                        {token.tradeCount.toLocaleString("en-US")}
                      </td>
                      <td>
                        <Link href={`/token/${token.address}`} className="badge ok">
                          Trade
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="panel pad" style={{ border: 0, borderRadius: 0 }}>
                <p className="hint">
                  {indexError
                    ? "Indexed market data could not be loaded, so no token ranking is shown."
                    : "No indexed tokens are available for this view yet."}
                </p>
              </div>
            )}
          </div>

          <aside className="home-section-card home-side-panel">
            <h2>Built for real trades</h2>
            <div className="trust-list">
              <div className="trust-row">
                <span className="trust-row-icon">✓</span>
                <div>
                  <strong>Live venue check</strong>
                  <p>Trading is offered only after the Pons venue is read from chain.</p>
                </div>
              </div>
              <div className="trust-row">
                <span className="trust-row-icon">◌</span>
                <div>
                  <strong>Honest data freshness</strong>
                  <p>
                    Indexer lag is surfaced rather than hidden behind a fake live chart.
                  </p>
                </div>
              </div>
              <div className="trust-row">
                <span className="trust-row-icon">◈</span>
                <div>
                  <strong>Non-custodial</strong>
                  <p>
                    Your wallet signs. STUNKS never receives a seed phrase or private key.
                  </p>
                </div>
              </div>
            </div>
          </aside>
        </section>

        <section className="protocol-disclosure">
          <details>
            <summary>Protocol telemetry and source-of-truth details</summary>
            {snapshot.ok && telemetry ? (
              <div className="stack" style={{ marginTop: 16 }}>
                <div>
                  <h2>Live chain status</h2>
                  <TelemetryTable rows={telemetry.chain} />
                </div>
                <div>
                  <h2>Live Pons V2 terms</h2>
                  <TelemetryTable rows={telemetry.protocol} />
                </div>
                {activeConfig && reserved !== null && reservedBps !== null && (
                  <div>
                    <h2>Active launch configuration</h2>
                    <TelemetryTable
                      rows={[
                        {
                          label: "Supply",
                          value: formatUnitsExact(activeConfig.supply, 18),
                          source: "getLaunchConfig().supply",
                        },
                        {
                          label: "Curve fee",
                          value: bpsToPercent(activeConfig.curveFeeBps),
                          source: "getLaunchConfig().curveFeeBps",
                        },
                        {
                          label: "Graduation threshold",
                          value: `${formatUnitsExact(activeConfig.graduationThreshold, 18)} ETH`,
                          source: "getLaunchConfig().graduationThreshold",
                        },
                        {
                          label: "Reserved for pool",
                          value: `${formatUnitsExact(reserved, 18)} (${bpsToPercent(reservedBps)} of supply)`,
                          source: "derived from launch configuration",
                        },
                      ]}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="error" style={{ marginTop: 16 }}>
                <p style={{ color: "var(--text)", marginBottom: 8 }}>
                  No RPC endpoint answered, so live protocol telemetry is not shown.
                </p>
                <p className="hint mono">
                  {snapshotError?.message ?? "Unknown RPC error"}
                </p>
                <p className="hint">
                  Endpoints tried: {snapshotError?.endpointsTried.join(", ") ?? "unknown"}
                </p>
              </div>
            )}
          </details>
        </section>
      </div>
    </main>
  );
}
