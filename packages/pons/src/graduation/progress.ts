import { BASIS_POINTS, ratioBps } from "@stunks/utils";
import { GraduationPhase } from "@stunks/types";

/**
 * Graduation progress.
 *
 * The subtlety the PRD missed: the on-chain TRIGGER is token-side —
 * `readyToGraduate()` is `sellableTokens() == 0`. The quote side is a floor that a
 * large trade can sail past; the token side is a hard stop the curve refuses to
 * cross.
 *
 * Because `phantomQuote * supply` is held constant, both describe the same point,
 * so the displayed percentage uses the quote side (as the PRD specifies) while any
 * behavioural gate uses the token side.
 */

export interface GraduationProgress {
  /** 0..10000. Uses realQuoteReserve, never the phantom-inclusive reserve. */
  readonly progressBps: bigint;
  readonly realQuoteReserve: bigint;
  readonly graduationThreshold: bigint;
  /** Token-side truth: the curve will not sell past this. */
  readonly sellableTokens: bigint;
  readonly readyToGraduate: boolean;
  readonly phase: GraduationPhase;
}

export function computeGraduationProgress(args: {
  realQuoteReserve: bigint;
  graduationThreshold: bigint;
  sellableTokens: bigint;
  phase: GraduationPhase;
}): GraduationProgress {
  const { realQuoteReserve, graduationThreshold, sellableTokens, phase } = args;

  // Anything past NotGraduated has, by definition, reached the threshold.
  const reachedThreshold = phase !== GraduationPhase.NotGraduated;
  const rawBps = ratioBps(realQuoteReserve, graduationThreshold);

  return {
    progressBps: reachedThreshold
      ? BASIS_POINTS
      : rawBps > BASIS_POINTS
        ? BASIS_POINTS
        : rawBps,
    realQuoteReserve,
    graduationThreshold,
    sellableTokens,
    readyToGraduate: phase === GraduationPhase.NotGraduated && sellableTokens === 0n,
    phase,
  };
}

/** Human-facing phase label. Deliberately explicit about the dead states. */
export function describePhase(phase: GraduationPhase): string {
  switch (phase) {
    case GraduationPhase.NotGraduated:
      return "Trading on bonding curve";
    case GraduationPhase.Swept:
      return "Graduating — pool not yet created";
    case GraduationPhase.PoolCreated:
      return "Graduated to Uniswap V4";
    case GraduationPhase.Rescued:
      return "Rescued — reserves released manually";
  }
}

/** Whether trading is possible at all in this phase. */
export function isTradeablePhase(phase: GraduationPhase): boolean {
  return phase === GraduationPhase.NotGraduated || phase === GraduationPhase.PoolCreated;
}

export function parseGraduationPhase(raw: number): GraduationPhase {
  switch (raw) {
    case 0:
      return GraduationPhase.NotGraduated;
    case 1:
      return GraduationPhase.Swept;
    case 2:
      return GraduationPhase.PoolCreated;
    case 3:
      return GraduationPhase.Rescued;
    default:
      // A new phase means the protocol changed under us. Refusing is safer than
      // guessing which venue applies.
      throw new Error(
        `Unknown GraduationPhase value ${raw}. The Pons protocol may have been ` +
          `upgraded; re-verify before trading.`,
      );
  }
}
