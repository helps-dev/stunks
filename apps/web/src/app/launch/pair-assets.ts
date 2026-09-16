import type { Address } from "viem";

/**
 * A launch pair that was both observed historically and verified live by the factory.
 *
 * The server builds this list immediately before rendering LaunchForm. The client still
 * cannot treat it as permanent approval — buildLaunchTransaction checks approval again
 * at signing time because Pons owners can change the set.
 */
export interface LaunchPairAsset {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly native: boolean;
  readonly historicalLaunchCount: number;
}
