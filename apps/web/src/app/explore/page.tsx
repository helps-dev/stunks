import type { ExploreSort } from "@stunks/database";
import { formatBlockLag, formatCompact } from "@stunks/utils";
import { BLOCK_TIME_SECONDS, KNOWN_RPC_ENDPOINTS } from "@stunks/config";
import { createReadClient } from "@stunks/web3";
import { exploreTokens, platformStats } from "@/lib/queries";
import { TokenCard } from "@/components/token-card";

/**
 * Explore.
 *
 * Every token here came from an indexed `TokenLaunched` event. There are no seeded or
 * example tokens, so an empty page means the indexer has not caught up — and the page
 * says exactly that rather than filling the space.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TABS: { key: ExploreSort; label: string }[] = [
  { key: "NEW", label: "New" },
  { key: "VOLUME_24H", label: "Volume" },
  { key: "MARKET_CAP", label: "Market cap" },
  { key: "GRADUATING", label: "Graduating" },
  { key: "TRENDING", label: "Trending" },
];

const PAGE_SIZE = 24;

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

async function chainHead(): Promise<bigint | null> {
  try {
    const { client } = createReadClient(endpoints());
    return await client.getBlockNumber();
  } catch {
    // Unreachable chain is reported by the staleness banner, not by failing the page:
    // indexed data is still worth showing, just labelled honestly.
    return null;
  }
}

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ExplorePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const rawSort = typeof params.sort === "string" ? params.sort : "NEW";
  const sort: ExploreSort = TABS.some((tab) => tab.key === rawSort)
    ? (rawSort as ExploreSort)
    : "NEW";
  const search = typeof params.q === "string" ? params.q : undefined;
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;

  const head = await chainHead();

  const [result, stats] = await Promise.all([
    exploreTokens({
      sort,
      limit: PAGE_SIZE,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(search !== undefined ? { search } : {}),
      chainHead: head,
    }),
    platformStats(),
  ]);

  const staleness = result.staleness;

  return (
    <main className="explore-page">
      <section className="explore-hero" data-reveal>
        <p className="page-kicker">Market discovery</p>
        <h1>
          Find your next
          <span className="text-brand"> curve.</span>
        </h1>
        <p>
          Discover real Pons V2 launches indexed from Robinhood Chain. Every metric below
          is labelled with its freshness so you can see what the indexer has actually
          reached.
        </p>
      </section>

      <div className="statsrow explore-stats">
        <Stat label="Tokens indexed" value={stats.tokenCount.toLocaleString("en-US")} />
        <Stat label="Graduated" value={stats.graduatedCount.toLocaleString("en-US")} />
        <Stat label="Trades" value={stats.tradeCount.toLocaleString("en-US")} />
        <Stat label="Creators" value={stats.creatorCount.toLocaleString("en-US")} />
        <Stat
          label="Indexed volume"
          value={`${formatCompact(BigInt(stats.totalVolume), 18)} quote`}
        />
      </div>

      {/*
        Honest about how current this is, including when it is not current.

        The headline figure is the SLOWEST stream, because that is what actually bounds
        the numbers below: prices and volume come from the curve stream, and it is the
        one structurally capable of falling a long way behind. Each stream is then named
        individually, so "behind" points at where the backlog really is.
      */}
      <div className={staleness.isStale ? "indexer-status stale" : "indexer-status"}>
        <span className="indexer-status-icon">{staleness.isStale ? "!" : "✓"}</span>
        <div>
          <strong>{staleness.isStale ? "Indexer catching up" : "Indexer current"}</strong>
          {staleness.lagBlocks !== null ? (
            <p>
              Indexed to block <span className="mono">{staleness.indexedBlock}</span> of{" "}
              <span className="mono">{staleness.chainHead}</span> —{" "}
              {formatBlockLag(BigInt(staleness.lagBlocks), BLOCK_TIME_SECONDS)}
              {staleness.stream !== null && `, bounded by the ${staleness.stream} stream`}
              .{staleness.isStale && " Figures below may be behind the chain."}
            </p>
          ) : (
            <p>
              Could not determine current chain lag. Treat metrics as indicative only.
            </p>
          )}
          {staleness.streams.length > 0 && (
            <ul className="indexer-streams">
              {staleness.streams.map((stream) => (
                <li key={stream.stream}>
                  <span className="indexer-stream-name">{stream.stream}</span>{" "}
                  <span className="mono">{stream.indexedBlock}</span>
                  {stream.lagBlocks !== null && (
                    <> — {formatBlockLag(BigInt(stream.lagBlocks), BLOCK_TIME_SECONDS)}</>
                  )}
                  {stream.isPaused && " — paused"}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/*
        The trending sort orders by a column nothing writes, so every row holds 0 and
        the result degenerates to an arbitrary order. A list of tokens looks the same
        either way, which is exactly why it has to be said rather than shown.
      */}
      {!result.trendingScored && (
        <div className="indexer-status stale">
          <span className="indexer-status-icon">!</span>
          <div>
            <strong>Trending is not scored yet</strong>
            <p>
              No token carries a trending score, so this list is ordered arbitrarily and
              is not a ranking. Scoring needs a periodic pass over the whole cohort, and
              it needs the curve stream close to the head — a 24-hour window computed over
              trades that end a day ago would rank nothing meaningful. Sort by volume,
              market cap or graduation progress in the meantime.
            </p>
          </div>
        </div>
      )}

      <section className="explore-browse" data-reveal>
        <div className="section-heading">
          <div>
            <p className="page-kicker">Browse live index</p>
            <h2>{search ? "Search results" : "Token terminal"}</h2>
          </div>
          <span className="badge ok">Zero STUNKS fee</span>
        </div>

        <form className="searchrow" method="get">
          <input
            type="search"
            name="q"
            defaultValue={search ?? ""}
            placeholder="Search symbol, name, or paste a contract address"
            aria-label="Search tokens"
          />
          <input type="hidden" name="sort" value={sort} />
          <button type="submit" className="btn btn-primary">
            Search
          </button>
        </form>

        <nav className="tabs" aria-label="Token sorting">
          {TABS.map((tab) => {
            const query = new URLSearchParams({ sort: tab.key });
            if (search) query.set("q", search);
            return (
              <a
                key={tab.key}
                href={`/explore?${query.toString()}`}
                className={tab.key === sort ? "tab active" : "tab"}
              >
                {tab.label}
              </a>
            );
          })}
        </nav>

        {result.tokens.length === 0 ? (
          <div className="empty-state panel">
            <span className="empty-state-mark">⌕</span>
            <h3>No token found</h3>
            <p>
              {search
                ? `Nothing indexed matches "${search}".`
                : "No tokens are indexed for this view yet. The indexer may still be catching up."}
            </p>
          </div>
        ) : (
          <>
            <div className="cardgrid">
              {result.tokens.map((token) => (
                <TokenCard key={token.address} token={token} />
              ))}
            </div>

            {result.hasMore && result.nextCursor && (
              <div className="pagination-row">
                <a
                  className="btn"
                  href={`/explore?${new URLSearchParams({
                    sort,
                    ...(search ? { q: search } : {}),
                    cursor: result.nextCursor,
                  }).toString()}`}
                >
                  Load more tokens →
                </a>
              </div>
            )}
          </>
        )}
      </section>
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
