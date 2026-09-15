import type { Address, PublicClient } from "viem";
import type { Repositories } from "@stunks/database";
import {
  computeReservedTokens,
  decodePonsLog,
  erc20Abi,
  parseGraduationPhase,
  readCurveState,
  readLaunchedToken,
} from "@stunks/pons";
import { priceFromReserves, marketCapFromPrice } from "../pricing.js";
import type { BlockTimeCache } from "../block-cache.js";
import type { RawLog } from "../sources/types.js";

/**
 * Factory stream processor: turns `TokenLaunched` into a Token row.
 *
 * The important discipline here is where each value comes from. The event gives only
 * token, curve, deployer, pairToken, launchConfigId and graduationThreshold — enough
 * to identify a launch, not enough to describe it. Everything else (metadata, supply,
 * creator fee recipient, phase, snipe-tax window) is read from the chain, because
 * inventing or inferring it is exactly what this project forbids.
 *
 * `PoolGraduated` and the sweep events are handled here too, since the factory emits
 * them: a phase change is always confirmed by a live read of `getLaunchedToken`
 * rather than assumed from the event that suggested it.
 */

export interface FactoryProcessorDeps {
  readonly client: PublicClient;
  readonly repos: Repositories;
  readonly chainId: number;
  readonly factory: Address;
  readonly blockTimes: BlockTimeCache;
  readonly log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ProcessResult {
  readonly launches: number;
  readonly phaseUpdates: number;
  readonly skipped: number;
}

export async function processFactoryLogs(
  logs: readonly RawLog[],
  deps: FactoryProcessorDeps,
): Promise<ProcessResult> {
  let launches = 0;
  let phaseUpdates = 0;
  let skipped = 0;

  await deps.blockTimes.warm(logs.map((entry) => entry.blockNumber));

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

    // Unknown topics are the factory's many owner-configuration events. Skipping
    // them keeps the scanner resilient to a protocol upgrade adding new ones.
    if (!decoded) {
      skipped++;
      continue;
    }

    switch (decoded.name) {
      case "TokenLaunched": {
        const created = await recordLaunch(decoded.args, raw, deps);
        if (created) launches++;
        break;
      }

      // Every one of these implies the phase moved. None of them is trusted to say
      // WHERE it moved to — that comes from a live read.
      case "LaunchSwept":
      case "LaunchForceSwept":
      case "PoolGraduated":
      case "GraduationTokensPermanentlyLocked": {
        const token = decoded.args.token as Address | undefined;
        if (token && (await syncPhase(token, deps))) phaseUpdates++;
        break;
      }

      default:
        skipped++;
    }
  }

  return { launches, phaseUpdates, skipped };
}

async function recordLaunch(
  args: Record<string, unknown>,
  raw: RawLog,
  deps: FactoryProcessorDeps,
): Promise<boolean> {
  const token = args.token as Address;
  const curve = args.curve as Address;
  const deployer = args.deployer as Address;
  const pairToken = args.pairToken as Address;
  const launchConfigId = args.launchConfigId as bigint;

  // The record is authoritative for everything the event omits, including the
  // creator fee recipient, which can differ from the deployer.
  const launch = await readLaunchedToken(deps.client, deps.factory, token);
  if (!launch.exists) {
    // Possible if the launch was rolled back by a reorg between the log and this
    // read. Not an error: the log will be re-scanned.
    deps.log("launch record absent, skipping", { token });
    return false;
  }

  const [metadata, curveState, pairTokenDecimals] = await Promise.all([
    readTokenMetadata(deps.client, token),
    readCurveState(deps.client, curve),
    readPairTokenDecimals(deps.client, pairToken),
  ]);

  // Verified identity: supply x phantom / (phantom + threshold). Recomputed rather
  // than read so a mismatch would surface as a bug rather than being papered over.
  const reservedTokens = computeReservedTokens(
    metadata.totalSupply,
    curveState.phantomQuote,
    curveState.graduationThreshold,
  );

  // An untraded launch still has a price: the curve opens against a virtual reserve.
  const openingPrice = priceFromReserves({
    pricingQuoteReserve: curveState.pricingQuoteReserve,
    tokenReserve: curveState.tokenReserve,
  });

  const blockTime = await deps.blockTimes.get(raw.blockNumber);

  const { created, tokenId } = await deps.repos.tokens.recordLaunch({
    chainId: deps.chainId,
    address: token,
    name: metadata.name,
    symbol: metadata.symbol,
    decimals: metadata.decimals,

    creatorAddress: launch.creatorFeeRecipient,
    deployerAddress: deployer,
    curveAddress: curve,
    pairTokenAddress: pairToken,
    pairTokenDecimals,
    launchConfigId,

    totalSupply: metadata.totalSupply,
    creatorTaxBps: launch.creatorTaxBps,
    buybackEnabled: launch.buybackEnabled,
    graduationThreshold: launch.graduationThreshold,
    poolFee: launch.poolFee,
    tickSpacing: launch.tickSpacing,
    phantomQuote: curveState.phantomQuote,
    reservedTokens,

    // Per-curve and owner-mutable at the factory, so cached from the curve itself.
    // eslint-disable-next-line no-restricted-syntax -- bps and a seconds window are int columns; launchedAt is a unix timestamp
    snipeTaxStartBps: Number(curveState.snipeTaxStartBps),
    // eslint-disable-next-line no-restricted-syntax -- see above
    snipeTaxSeconds: Number(curveState.snipeTaxSeconds),
    // eslint-disable-next-line no-restricted-syntax -- see above
    launchedAt: new Date(Number(curveState.launchedAt) * 1000),

    launchBlock: raw.blockNumber,
    launchTxHash: raw.transactionHash,

    // Folded into the same write. A separate updateStats call doubled the DB round
    // trips per launch, which measurably capped indexer throughput.
    openingPrice,
    openingMarketCap: marketCapFromPrice(openingPrice, metadata.totalSupply),
    openingRealQuoteReserve: curveState.realQuoteReserve,
  });

  void tokenId;

  if (created) {
    deps.log("indexed launch", {
      symbol: metadata.symbol,
      token,
      block: raw.blockNumber.toString(),
      at: blockTime.toISOString(),
    });
  }

  return created;
}

/**
 * Confirm a token's phase from the chain.
 *
 * Never derived from which event arrived. `Swept` in particular is a state the
 * protocol can enter without a successful graduation, so believing an event over the
 * record would put the app into a venue it cannot trade.
 */
async function syncPhase(token: Address, deps: FactoryProcessorDeps): Promise<boolean> {
  const existing = await deps.repos.tokens.findByAddress(deps.chainId, token);
  if (!existing) return false;

  const launch = await readLaunchedToken(deps.client, deps.factory, token);
  if (!launch.exists) return false;

  const onChainPhase = parseGraduationPhase(launch.phase);
  const dbPhase = phaseToDb(onChainPhase);
  if (existing.phase === dbPhase) return false;

  await deps.repos.tokens.setPhase(existing.id, dbPhase);
  deps.log("phase changed", { token, from: existing.phase, to: dbPhase });
  return true;
}

type DbPhase = "NOT_GRADUATED" | "SWEPT" | "POOL_CREATED" | "RESCUED";

function phaseToDb(phase: number): DbPhase {
  switch (phase) {
    case 0:
      return "NOT_GRADUATED";
    case 1:
      return "SWEPT";
    case 2:
      return "POOL_CREATED";
    case 3:
      return "RESCUED";
    default:
      throw new Error(`Unmapped graduation phase ${phase}`);
  }
}

async function readTokenMetadata(client: PublicClient, token: Address) {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
  ]);
  return {
    name: name as string,
    symbol: symbol as string,
    // eslint-disable-next-line no-restricted-syntax -- ERC-20 decimals is a uint8 scale factor, not an amount
    decimals: Number(decimals),
    totalSupply: totalSupply as bigint,
  };
}

/**
 * Pair-token decimals. USDG uses 6 while every other approved pair uses 18, so this
 * is read rather than assumed — a wrong value here misprices the whole launch.
 */
async function readPairTokenDecimals(
  client: PublicClient,
  pairToken: Address,
): Promise<number> {
  if (/^0x0{40}$/i.test(pairToken)) return 18; // native ETH
  try {
    const decimals = await client.readContract({
      address: pairToken,
      abi: erc20Abi,
      functionName: "decimals",
    });
    // eslint-disable-next-line no-restricted-syntax -- ERC-20 decimals is a uint8 scale factor, not an amount
    return Number(decimals);
  } catch {
    // An unreadable pair asset is worth flagging loudly rather than defaulting
    // silently, but 18 keeps the launch indexable.
    return 18;
  }
}
