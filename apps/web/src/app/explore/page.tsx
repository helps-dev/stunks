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
 *
 * The staleness banner is not optional politeness. The indexer currently sustains fewer
 * blocks per second than the chain produces, so these figures can genuinely lag, and a
 * user comparing them against a wallet balance deserves to know.
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
    <main>
      <h1>Explore</h1>
      <p>
        Tokens launched through Pons V2 on Robinhood Chain, indexed from on-chain events.
        STUNKS charges no fee.
      </p>

      <div className="statsrow">
        <Stat label="Tokens indexed" value={stats.tokenCount.toLocaleString("en-US")} />
        <Stat label="Graduated" value={stats.graduatedCount.toLocaleString("en-US")} />
        <Stat label="Trades" value={stats.tradeCount.toLocaleString("en-US")} />
        <Stat label="Creators" value={stats.creatorCount.toLocaleString("en-US")} />
        <Stat
          label="Volume (all time)"
          value={`${formatCompact(BigInt(stats.totalVolume), 18)} ETH`}
        />
      </div>

      {/* Honest about how current this is, including when it is not current. */}
      <div
        className={staleness.isStale ? "error" : "panel pad"}
        style={{ marginTop: 16 }}
      >
        {staleness.lagBlocks !== null ? (
          <p className="hint" style={{ margin: 0 }}>
            Indexed to block <span className="mono">{staleness.indexedBlock}</span> of{" "}
            <span className="mono">{staleness.chainHead}</span> —{" "}
            {formatBlockLag(BigInt(staleness.lagBlocks), BLOCK_TIME_SECONDS)}.
            {staleness.isStale &&
              " Figures below may be well behind the chain. Treat them as indicative, not current."}
          </p>
        ) : (
          <p className="hint" style={{ margin: 0 }}>
            Could not determine how far the indexer is behind. Treat these figures as
            indicative only.
          </p>
        )}
      </div>

      <h2>Browse</h2>
      <form className="searchrow" method="get">
        <input
          type="search"
          name="q"
          defaultValue={search ?? ""}
          placeholder="Search symbol, name, or paste a contract address"
          aria-label="Search tokens"
        />
        <input type="hidden" name="sort" value={sort} />
        <button type="submit" className="btn">
          Search
        </button>
      </form>

      <nav className="tabs">
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
        <div className="panel pad">
          <p className="hint" style={{ margin: 0 }}>
            {search
              ? `Nothing indexed matches "${search}".`
              : "No tokens indexed yet for this view. The indexer may still be catching up — " +
                "this space is left empty rather than filled with examples."}
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
            <div style={{ marginTop: 20 }}>
              <a
                className="btn"
                href={`/explore?${new URLSearchParams({
                  sort,
                  ...(search ? { q: search } : {}),
                  cursor: result.nextCursor,
                }).toString()}`}
              >
                Next page
              </a>
            </div>
          )}
        </>
      )}
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
