/**
 * Pure funding and capability rules for the launch editor.
 *
 * Amounts are already quote-asset base units. This module deliberately knows nothing
 * about React or wallet providers, making the financial summary testable without
 * rendering a signing UI.
 */

export function nativePrincipalRequired(args: {
  readonly launchFee: bigint;
  readonly developerBuy: bigint;
  readonly protectedBuyTotal: bigint;
}): bigint {
  return args.launchFee + args.developerBuy + args.protectedBuyTotal;
}

/**
 * The bundle sequence is native-only. A newly launched ERC-20 curve needs an allowance
 * that cannot be safely approved before the receipt reveals and verifies its address.
 */
export function supportsProtectedBuySequence(nativePair: boolean): boolean {
  return nativePair;
}

/** A pair metadata scale changed after the form rendered; amounts need review. */
export function decimalsChanged(renderedDecimals: number, liveDecimals: number): boolean {
  return renderedDecimals !== liveDecimals;
}
