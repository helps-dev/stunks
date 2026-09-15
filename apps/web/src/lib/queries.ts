import { createRepositories, getPrisma } from "@stunks/database";
import type { ExploreSort, TokenSummary } from "@stunks/database";
import { BLOCK_TIME_SECONDS, ROBINHOOD_CHAIN_ID } from "@stunks/config";

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
}

/**
 * How current the data is.
 *
 * Surfaced rather than hidden. The indexer currently sustains fewer blocks per second
 * than the chain produces, so a page can legitimately be showing state from a while
 * ago — and letting a user assume otherwise on a trading interface would be
 * indefensible.
 */
export interface IndexerStaleness {
  readonly indexedBlock: string | null;
  readonly chainHead: string | null;
  readonly lagBlocks: string | null;
  readonly lagSeconds: number | null;
  readonly lastSuccessAt: string | null;
  readonly isStale: boolean;
}

export async function readStaleness(chainHead: bigint | null): Promise<IndexerStaleness> {
  const streams = await repos.explore.indexerLag(ROBINHOOD_CHAIN_ID);
  const factory = streams.find((stream) => stream.stream === "factory");

  if (!factory) {
    return {
      indexedBlock: null,
      chainHead: chainHead?.toString() ?? null,
      lagBlocks: null,
      lagSeconds: null,
      lastSuccessAt: null,
      isStale: true,
    };
  }

  const lag = chainHead === null ? null : chainHead - factory.lastProcessedBlock;
  const lagSeconds =
    lag === null
      ? null
      : // eslint-disable-next-line no-restricted-syntax -- a block count is not money; this is a human-readable estimate
        Math.round(Number(lag) * BLOCK_TIME_SECONDS);

  return {
    indexedBlock: factory.lastProcessedBlock.toString(),
    chainHead: chainHead?.toString() ?? null,
    lagBlocks: lag?.toString() ?? null,
    lagSeconds,
    lastSuccessAt: factory.lastSuccessAt?.toISOString() ?? null,
    // A minute of lag is ~600 blocks here, which is normal. Ten minutes is not.
    isStale: lagSeconds === null || lagSeconds > 600,
  };
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
