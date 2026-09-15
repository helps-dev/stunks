import { decodeEventLog, toEventSelector, type Hex, type Log } from "viem";
import { ponsV2FactoryAbi } from "../abi/factory.js";
import { ponsV2CurveAbi } from "../abi/curve.js";
import { ponsV2MemeHookAbi } from "../abi/hook.js";

/**
 * Event decoding, keyed by topic0.
 *
 * The names here matter. The PRD assumed the trade events were `Buy` and `Sell`.
 * They are `CurveBuy` and `CurveSell`, emitted by the per-launch curve contract —
 * there is one curve per token, not a shared pool. `TokenLaunched` was verified by
 * decoding a real mainnet log:
 *
 *   topic0 0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607
 */

export const FACTORY_EVENT_NAMES = [
  "TokenLaunched",
  "LaunchSwept",
  "LaunchForceSwept",
  "PoolGraduated",
  "GraduationTokensPermanentlyLocked",
  "LaunchConfigAdded",
  "LaunchConfigUpdated",
] as const;

export const CURVE_EVENT_NAMES = [
  "CurveBuy",
  "CurveSell",
  "CurveBuyRefunded",
  "FeesSwept",
  "BuybackLocked",
  "CurveCompleted",
  "AutoGraduationFailed",
] as const;

export const HOOK_EVENT_NAMES = ["PoolRegistered", "HookFeeCollected"] as const;

function buildTopicMap(
  abi: readonly unknown[],
  names: readonly string[],
): Record<Hex, string> {
  const map: Record<Hex, string> = {};
  for (const entry of abi as { type: string; name?: string; inputs?: unknown[] }[]) {
    if (entry.type !== "event" || !entry.name || !names.includes(entry.name)) continue;
    const signature = `${entry.name}(${(entry.inputs ?? [])
      .map((input) => (input as { type: string }).type)
      .join(",")})`;
    map[toEventSelector(signature)] = entry.name;
  }
  return map;
}

export const FACTORY_TOPICS = buildTopicMap(ponsV2FactoryAbi, FACTORY_EVENT_NAMES);
export const CURVE_TOPICS = buildTopicMap(ponsV2CurveAbi, CURVE_EVENT_NAMES);
export const HOOK_TOPICS = buildTopicMap(ponsV2MemeHookAbi, HOOK_EVENT_NAMES);

/**
 * A decoded event plus the identity that makes indexing idempotent.
 * `(chainId, transactionHash, logIndex)` is the unique key; a restart or replay
 * must never double-count a trade.
 */
export interface DecodedPonsEvent {
  readonly source: "FACTORY" | "CURVE" | "HOOK";
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly address: `0x${string}`;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export type PonsEventSource = DecodedPonsEvent["source"];

/**
 * Decode a log if it is one we care about, otherwise return null.
 *
 * Returning null for unknown topics is deliberate: the factory and hook emit many
 * owner-configuration events that the indexer has no business interpreting, and
 * throwing on them would make the scanner brittle against protocol upgrades.
 */
export function decodePonsLog(log: Log): DecodedPonsEvent | null {
  const topic0 = log.topics[0];
  if (!topic0) return null;
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    return null;
  }

  const candidates: {
    source: PonsEventSource;
    abi: readonly unknown[];
    map: Record<Hex, string>;
  }[] = [
    { source: "FACTORY", abi: ponsV2FactoryAbi, map: FACTORY_TOPICS },
    { source: "CURVE", abi: ponsV2CurveAbi, map: CURVE_TOPICS },
    { source: "HOOK", abi: ponsV2MemeHookAbi, map: HOOK_TOPICS },
  ];

  for (const candidate of candidates) {
    const name = candidate.map[topic0];
    if (!name) continue;
    try {
      const decoded = decodeEventLog({
        abi: candidate.abi as never,
        data: log.data,
        topics: log.topics,
      });
      return {
        source: candidate.source,
        name,
        args: (decoded.args ?? {}) as Record<string, unknown>,
        address: log.address,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      };
    } catch {
      // Topic matched but payload did not decode — a signature collision or a
      // protocol change. Skip rather than corrupt state with a wrong decode.
      return null;
    }
  }
  return null;
}

/** The idempotency key. Used as the unique constraint on indexed rows. */
export function eventKey(
  chainId: number,
  transactionHash: Hex,
  logIndex: number,
): string {
  return `${chainId}:${transactionHash}:${logIndex}`;
}
