import type { ExploreSort } from "@stunks/database";
import { formatCompact } from "@stunks/utils";
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

  const [result, stats] = await Promise.all([
    exploreTokens({
      sort,
      limit: PAGE_SIZE,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(search !== undefined ? { search } : {}),
      // Null, deliberately. This page no longer shows how far behind the index is,
      // and reading the chain head is a network round trip on the render path — with
      // a 3-second timeout — that would feed nothing. Passing a head again is all it
      // takes to bring the freshness banner back.
      chainHead: null,
    }),
    platformStats(),
  ]);


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
