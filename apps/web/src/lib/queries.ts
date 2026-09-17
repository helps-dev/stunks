import { createRepositories, getPrisma } from "@stunks/database";
import type { ExploreSort, TokenSummary } from "@stunks/database";
import { ROBINHOOD_CHAIN_ID } from "@stunks/config";
import { summariseStaleness } from "./staleness.js";
import type { IndexerStaleness, StreamStaleness } from "./staleness.js";

/**
 * Server-side data access for the web app.
 *
 * Next server components read the database directly here. That is deliberate for now:
 * a separate HTTP API buys nothing while the only consumer is this app, and it would
 * add a serialisation hop for data that already needs one at the client boundary.
 * `apps/api` becomes worthwhile when there is an external consumer.
 *
 * Everything crossing into a client component is serialised explicitly. A bigint
 * cannot survive `JSON.stringify`, and a silent `Number()` on a uint256 is precisely
 * the failure this project is built to avoid — so money leaves as a decimal string and
 * is parsed back when it needs arithmetic.
 */

const repos = createRepositories(getPrisma());

/** Re-exported so pages keep importing their view models from one module. */
export type { IndexerStaleness, StreamStaleness };

export interface SerialisedToken {
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly imageUrl: string | null;
  readonly creatorAddress: string;
  readonly pairTokenAddress: string;
  readonly pairTokenDecimals: number;
  readonly phase: string;
  readonly price: string;
  readonly marketCap: string;
  readonly volume24h: string;
  readonly volumeTotal: string;
  readonly graduationBps: number;
  readonly holderCount: number;
  readonly tradeCount: number;
  readonly creatorTaxBps: number;
  readonly totalSupply: string;
  readonly hadWhitelistBundle: boolean;
  readonly whitelistSize: number;
  readonly moderationStatus: string;
  readonly launchBlock: string;
  readonly createdAt: string;
  readonly lastTradeAt: string | null;
}

function serialiseToken(token: TokenSummary): SerialisedToken {
  return {
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    imageUrl: token.imageUrl,
    creatorAddress: token.creatorAddress,
    pairTokenAddress: token.pairTokenAddress,
    pairTokenDecimals: token.pairTokenDecimals,
    phase: token.phase,
    price: token.price.toString(),
    marketCap: token.marketCap.toString(),
    volume24h: token.volume24h.toString(),
    volumeTotal: token.volumeTotal.toString(),
    graduationBps: token.graduationBps,
    holderCount: token.holderCount,
    tradeCount: token.tradeCount,
    creatorTaxBps: token.creatorTaxBps,
    totalSupply: token.totalSupply.toString(),
    hadWhitelistBundle: token.hadWhitelistBundle,
    whitelistSize: token.whitelistSize,
    moderationStatus: token.moderationStatus,
    launchBlock: token.launchBlock.toString(),
    createdAt: token.createdAt.toISOString(),
    lastTradeAt: token.lastTradeAt?.toISOString() ?? null,
  };
}

export interface ExploreResult {
  readonly tokens: readonly SerialisedToken[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly staleness: IndexerStaleness;
  /**
   * False when the trending sort was asked for and no token carries a score.
   *
   * The result set looks identical either way — a list of tokens — so without this
   * the page would present an arbitrary order as a ranking.
   */
  readonly trendingScored: boolean;
}

/**
 * How current the data is.
 *
 * Surfaced rather than hidden. The indexer currently sustains fewer blocks per second
 * than the chain produces, so a page can legitimately be showing state from a while
 * ago — and letting a user assume otherwise on a trading interface would be
 * indefensible.
 *
 * The selection rule lives in `./staleness` so it can be tested without a database.
 * It reports the SLOWEST required stream; see that module for why.
 */
export async function readStaleness(chainHead: bigint | null): Promise<IndexerStaleness> {
  const states = await repos.explore.indexerLag(ROBINHOOD_CHAIN_ID);
  return summariseStaleness(states, chainHead);
}

export async function exploreTokens(args: {
  sort: ExploreSort;
  limit: number;
  cursor?: string;
  search?: string;
  chainHead: bigint | null;
}): Promise<ExploreResult> {
  const page = await repos.explore.listTokens({
    chainId: ROBINHOOD_CHAIN_ID,
    sort: args.sort,
    limit: args.limit,
    ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    ...(args.search !== undefined ? { search: args.search } : {}),
    ...(args.sort === "GRADUATING" ? {} : {}),
  });

  return {
    tokens: page.items.map(serialiseToken),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    staleness: await readStaleness(args.chainHead),
    // Only asked when it can change what the page says, which is the trending sort.
    trendingScored:
      args.sort === "TRENDING"
        ? await repos.explore.anyTrendingScore(ROBINHOOD_CHAIN_ID)
        : true,
  };
}

export async function platformStats() {
  const stats = await repos.explore.platformStats(ROBINHOOD_CHAIN_ID);
  return {
    tokenCount: stats.tokenCount,
    graduatedCount: stats.graduatedCount,
    tradeCount: stats.tradeCount,
    creatorCount: stats.creatorCount,
    totalVolume: stats.totalVolume.toString(),
    // Zero, and verified: Pons V2 routes nothing to third-party interfaces.
    platformRevenue: stats.platformRevenue.toString(),
  };
}

export interface LaunchPairCandidate {
  readonly address: string;
  readonly decimals: number;
  readonly launchCount: number;
}

/**
 * Historical discovery candidates for the launch pair selector.
 *
 * These are intentionally not labelled "approved" here. The launch route verifies
 * current factory approval and ERC-20 metadata from chain before passing anything to
 * the client form.
 */
export async function launchPairCandidates(): Promise<readonly LaunchPairCandidate[]> {
  return repos.explore.listSeenPairTokens(ROBINHOOD_CHAIN_ID);
}

export async function tokenDetail(address: string) {
  return repos.explore.getToken(ROBINHOOD_CHAIN_ID, address);
}

export async function tokenTrades(tokenId: string, limit: number) {
  return repos.explore.listTrades({ tokenId, limit });
}

export async function tokenHolders(tokenId: string, limit: number) {
  return repos.explore.listHolders({ tokenId, limit });
}

export { repos };
