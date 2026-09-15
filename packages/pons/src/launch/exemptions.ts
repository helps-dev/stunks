import { getAddress, isAddress, type Address } from "viem";
import {
  MAX_DECLARABLE_SNIPE_EXEMPTIONS,
  MAX_SNIPE_EXEMPTIONS_ON_CHAIN,
  ZERO_ADDRESS,
} from "@stunks/config";

/**
 * Whitelist (snipe-tax exemption) validation for a launch.
 *
 * Why this is a real module rather than an inline length check:
 *
 *  - The limit is enforced on-chain only AFTER the launch fee is committed.
 *    A creator who supplies a 32nd address loses the fee to a revert. So the cap
 *    has to be enforced before signing, with a message that explains it.
 *  - The list is written during `launchToken` / `launchAndBuy` and there is NO
 *    add-later path, not even for the creator. Getting it wrong is permanent for
 *    that launch.
 *  - The list is public calldata forever. Nothing about it can be concealed.
 *
 * Verified first-hand by simulation (`pnpm probe:exemptions`): 31 declared
 * addresses is accepted, 32 reverts.
 */

export interface ExemptionValidationInput {
  /** Addresses the creator wants exempted, as typed. */
  readonly addresses: readonly string[];
  /** The launching wallet. Auto-exempted by the factory, so it needs no slot. */
  readonly deployer: Address;
  /** Also auto-exempted when it differs from the deployer. */
  readonly creatorFeeRecipient?: Address;
}

export interface ExemptionValidationResult {
  /** Normalised, de-duplicated list safe to encode into the launch call. */
  readonly addresses: readonly Address[];
  /** Blocking problems. A non-empty list means do not let the user sign. */
  readonly errors: readonly string[];
  /** Non-blocking observations worth showing. */
  readonly warnings: readonly string[];
  readonly slotsUsed: number;
  readonly slotsRemaining: number;
}

export function validateSnipeExemptions(
  input: ExemptionValidationInput,
): ExemptionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalised: Address[] = [];
  const seen = new Set<string>();

  const autoExempt = new Set<string>([input.deployer.toLowerCase()]);
  if (
    input.creatorFeeRecipient &&
    input.creatorFeeRecipient.toLowerCase() !== input.deployer.toLowerCase()
  ) {
    autoExempt.add(input.creatorFeeRecipient.toLowerCase());
  }

  for (const [index, raw] of input.addresses.entries()) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;

    if (!isAddress(trimmed)) {
      errors.push(`Entry ${index + 1} is not a valid address: ${trimmed}`);
      continue;
    }

    const checksummed = getAddress(trimmed);
    const lower = checksummed.toLowerCase();

    if (lower === ZERO_ADDRESS.toLowerCase()) {
      errors.push(`Entry ${index + 1} is the zero address, which cannot receive tokens.`);
      continue;
    }

    if (seen.has(lower)) {
      // Not fatal: a duplicate wastes a slot rather than reverting, but the
      // creator almost certainly did not mean to spend one.
      warnings.push(`${checksummed} appears more than once; the duplicate was removed.`);
      continue;
    }

    if (autoExempt.has(lower)) {
      warnings.push(
        `${checksummed} is exempted automatically as the launching wallet, so it does ` +
          `not need a slot. It was removed to free one.`,
      );
      continue;
    }

    seen.add(lower);
    normalised.push(checksummed);
  }

  if (normalised.length > MAX_DECLARABLE_SNIPE_EXEMPTIONS) {
    errors.push(
      `${normalised.length} addresses is more than Pons allows. You can declare at most ` +
        `${MAX_DECLARABLE_SNIPE_EXEMPTIONS}: the protocol ceiling is ` +
        `${MAX_SNIPE_EXEMPTIONS_ON_CHAIN} and the launch router reserves one slot for the ` +
        `buy recipient. Remove ${normalised.length - MAX_DECLARABLE_SNIPE_EXEMPTIONS} ` +
        `address(es). This limit is checked on-chain only after the launch fee is taken, ` +
        `so exceeding it would cost you the fee.`,
    );
  }

  return {
    addresses: normalised,
    errors,
    warnings,
    slotsUsed: normalised.length,
    slotsRemaining: Math.max(0, MAX_DECLARABLE_SNIPE_EXEMPTIONS - normalised.length),
  };
}

/**
 * Copy for the launch UI. Deliberately states the limits plainly, including the
 * parts a creator would rather not hear.
 */
export const EXEMPTION_DISCLOSURES = [
  `You can whitelist up to ${MAX_DECLARABLE_SNIPE_EXEMPTIONS} addresses. Your launching ` +
    `wallet is exempt automatically and does not use a slot.`,
  "The whitelist is fixed when the token launches. There is no way to add an address " +
    "afterwards, not even for you.",
  "The whitelist is stored publicly on-chain as part of your launch transaction. It " +
    "cannot be hidden from anyone, including cluster-analysis tools.",
  "Whitelisted wallets pay no anti-snipe tax. Everyone else pays a tax that starts near " +
    "99% and falls to zero within seconds, so the advantage is real but brief.",
  "STUNKS discloses on the token page that a launch used a whitelist bundle, and how " +
    "many recipients it had.",
] as const;
