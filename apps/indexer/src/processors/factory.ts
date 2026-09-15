import type { Address, PublicClient } from "viem";
import type { LaunchRecordInput, Repositories } from "@stunks/database";
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
 * Factory stream processor: `TokenLaunched` into Token rows.
 *
 * Two disciplines shape this file.
 *
 * WHERE VALUES COME FROM. The event carries only token, curve, deployer, pairToken,
 * launchConfigId and graduationThreshold — enough to identify a launch, not to describe
 * it. Metadata, supply, creator fee recipient, phase and the snipe-tax window are read
 * from the chain, because inventing or inferring them is what this project forbids.
 *
 * BATCHED WRITES. Chain reads for every launch in a window are gathered concurrently
 * (Multicall3 collapses them), then the whole window is written in one batch. The
 * earlier per-launch transaction cost ~2.7 s against a remote Postgres and was the
 * dominant reason the indexer could not keep pace with a 10 blocks/second chain.
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
  let phaseUpdates = 0;
  let skipped = 0;

  await deps.blockTimes.warm(logs.map((entry) => entry.blockNumber));

  const launchLogs: { args: Record<string, unknown>; raw: RawLog }[] = [];
  const phaseChanges: Address[] = [];

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

    // Unknown topics are the factory's many owner-configuration events. Skipping them
    // keeps the scanner resilient to a protocol upgrade adding new ones.
    if (!decoded) {
      skipped++;
      continue;
    }

    switch (decoded.name) {
      case "TokenLaunched":
        launchLogs.push({ args: decoded.args, raw });
        break;

      // Each implies the phase moved. None is trusted to say WHERE it moved to.
      case "LaunchSwept":
      case "LaunchForceSwept":
      case "PoolGraduated":
      case "GraduationTokensPermanentlyLocked": {
        const token = decoded.args.token as Address | undefined;
        if (token) phaseChanges.push(token);
        break;
      }

      default:
        skipped++;
    }
  }

  // ── Gather every launch's chain state concurrently, then write once ──
  let launches = 0;
  if (launchLogs.length > 0) {
    const prepared = await Promise.all(
      launchLogs.map((entry) => prepareLaunch(entry.args, entry.raw, deps)),
    );
    const inputs = prepared.filter((entry): entry is LaunchRecordInput => entry !== null);
    skipped += prepared.length - inputs.length;

    if (inputs.length > 0) {
      const result = await deps.repos.launchBatch.recordLaunches(deps.chainId, inputs);
      launches = result.tokensCreated;
      if (result.skipped > 0) skipped += result.skipped;
    }
  }

  // ── Phase changes, deduplicated ──
  for (const token of new Set(phaseChanges.map((t) => t.toLowerCase()))) {
    if (await syncPhase(token as Address, deps)) phaseUpdates++;
  }

  return { launches, phaseUpdates, skipped };
}

/**
 * Read everything needed for one launch. Returns null when the launch cannot be
 * described accurately, which is preferable to persisting a half-known record.
 */
async function prepareLaunch(
  args: Record<string, unknown>,
  raw: RawLog,
  deps: FactoryProcessorDeps,
): Promise<LaunchRecordInput | null> {
  const token = args.token as Address;
  const curve = args.curve as Address;
  const deployer = args.deployer as Address;
  const pairToken = args.pairToken as Address;
  const launchConfigId = args.launchConfigId as bigint;

  try {
    // The factory record is authoritative for what the event omits, including the
    // creator fee recipient, which can differ from the deployer.
    const launch = await readLaunchedToken(deps.client, deps.factory, token);
    if (!launch.exists) {
      // Possible if a reorg removed the launch between the log and this read. Not an
      // error: the log will be re-scanned.
      deps.log("launch record absent, skipping", { token });
      return null;
    }

    const [metadata, curveState, pairTokenDecimals, blockTime] = await Promise.all([
      readTokenMetadata(deps.client, token),
      readCurveState(deps.client, curve),
      readPairTokenDecimals(deps.client, pairToken),
      deps.blockTimes.get(raw.blockNumber),
    ]);

    // Verified identity: supply * phantom / (phantom + threshold). Recomputed rather
    // than read, so a mismatch surfaces as a bug instead of being papered over.
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

    void blockTime;

    return {
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

      // eslint-disable-next-line no-restricted-syntax -- bps and a seconds window are int columns
      snipeTaxStartBps: Number(curveState.snipeTaxStartBps),
      // eslint-disable-next-line no-restricted-syntax -- see above
      snipeTaxSeconds: Number(curveState.snipeTaxSeconds),
      // eslint-disable-next-line no-restricted-syntax -- unix timestamp, not an amount
      launchedAt: new Date(Number(curveState.launchedAt) * 1000),

      launchBlock: raw.blockNumber,
      launchTxHash: raw.transactionHash,

      openingPrice,
      openingMarketCap: marketCapFromPrice(openingPrice, metadata.totalSupply),
      openingRealQuoteReserve: curveState.realQuoteReserve,
    };
  } catch (error) {
    deps.log("failed to prepare launch", {
      token,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Confirm a token's phase from the chain.
 *
 * Never derived from which event arrived. `Swept` is reachable without a successful
 * graduation, so believing an event over the record would put the app into a venue it
 * cannot trade.
 */
async function syncPhase(token: Address, deps: FactoryProcessorDeps): Promise<boolean> {
  const existing = await deps.repos.tokens.findByAddress(deps.chainId, token);
  if (!existing) return false;

  const launch = await readLaunchedToken(deps.client, deps.factory, token);
  if (!launch.exists) return false;

  const dbPhase = phaseToDb(parseGraduationPhase(launch.phase));
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
    // eslint-disable-next-line no-restricted-syntax -- ERC-20 decimals is a uint8 scale factor
    decimals: Number(decimals),
    totalSupply: totalSupply as bigint,
  };
}

/**
 * Pair-token decimals. USDG uses 6 while every other approved pair uses 18, so this is
 * read rather than assumed — a wrong value here misprices the whole launch.
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
    // eslint-disable-next-line no-restricted-syntax -- ERC-20 decimals is a uint8 scale factor
    return Number(decimals);
  } catch {
    return 18;
  }
}
