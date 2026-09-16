import {
  encodeFunctionData,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { MAX_DECLARABLE_SNIPE_EXEMPTIONS, NATIVE_PAIR_TOKEN } from "@stunks/config";
import { ponsV2LaunchAndBuyAbi } from "../abi/hook.js";
import {
  previewLaunchEconomics,
  readFactoryParameters,
  readPairTokenApproved,
  isNativeQuote,
} from "../client/reads.js";
import { validateSnipeExemptions } from "./exemptions.js";

/**
 * Launch transaction builder.
 *
 * Every rule encoded here was verified against the deployed contracts, and each one
 * has a cost attached to getting it wrong:
 *
 * 1. `msg.value` is checked with `!=`, not `<`. Native launches must send exactly
 *    `launchFee + quoteIn`; ERC-20 launches exactly `launchFee`. One wei either way
 *    reverts `NativeValueMismatch` (0xbc760cfe) and the gas is gone.
 *
 * 2. `expectedEconomics` must be pinned. Zero waives the check, which lets the
 *    protocol owner re-peg supply, fee, threshold or pool tier underneath a launch
 *    that is already sitting in the user's wallet awaiting signature.
 *
 * 3. At most 31 exemptions may be declared — verified by simulation, 31 accepted and
 *    32 rejected. The contract enforces it only after taking the launch fee.
 *
 * 4. The creator's own buy is atomic via `PonsV2LaunchAndBuy`, so it cannot be
 *    front-run. The router passes the real caller through as `originalDeployer`, so
 *    the user stays the on-chain creator and keeps fee-sweep authority.
 */

export interface LaunchSocials {
  readonly website?: string;
  readonly twitter?: string;
  readonly telegram?: string;
  readonly discord?: string;
  readonly farcaster?: string;
}

export interface BuildLaunchInput {
  readonly name: string;
  readonly symbol: string;
  /** Prefer an ipfs:// URI: a gateway URL makes on-chain metadata depend on one host. */
  readonly logo: string;
  readonly description?: string;
  readonly socials?: LaunchSocials;

  readonly creator: Address;
  /** Defaults to the creator. Auto-exempted from the snipe tax when it differs. */
  readonly creatorFeeRecipient?: Address;
  readonly creatorTaxBps: number;
  readonly buybackEnabled: boolean;

  readonly launchConfigId: bigint;
  /** Zero address for native ETH. */
  readonly pairToken: Address;
  /** The creator's own opening buy, atomic with the launch. Zero to skip it. */
  readonly devBuyAmount: bigint;
  /** Slippage floor for the dev buy. */
  readonly minTokensOut: bigint;
  /** Recipient of the dev buy. Defaults to the creator. */
  readonly devBuyRecipient?: Address;

  readonly whitelist: readonly string[];
  /** Unique per creator. Also how a vanity token address is mined. */
  readonly salt?: Hex;
}

export interface BuiltLaunch {
  readonly to: Address;
  readonly data: Hex;
  /** Exact value. The contract compares with `!=`, so this cannot be rounded. */
  readonly value: bigint;
  readonly launchFee: bigint;
  readonly expectedEconomics: Hex;
  readonly salt: Hex;
  readonly whitelist: readonly Address[];
  readonly warnings: readonly string[];
}

export type BuildLaunchResult =
  | { readonly ok: true; readonly launch: BuiltLaunch }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Metadata caps that keep `socials()` readable on-chain. */
const LIMITS = {
  name: 64,
  symbol: 16,
  logo: 256,
  description: 512,
  social: 256,
} as const;

export function validateLaunchInput(
  input: BuildLaunchInput,
  maxCreatorTaxBps: bigint,
): string[] {
  const errors: string[] = [];

  if (input.name.trim() === "") errors.push("Token name is required.");
  if (input.name.length > LIMITS.name) {
    errors.push(`Name must be ${LIMITS.name} characters or fewer.`);
  }

  if (input.symbol.trim() === "") errors.push("Token symbol is required.");
  if (input.symbol.length > LIMITS.symbol) {
    errors.push(`Symbol must be ${LIMITS.symbol} characters or fewer.`);
  }

  if (input.logo.trim() === "") errors.push("Token image is required.");
  if (input.logo.length > LIMITS.logo) {
    errors.push(`Image URI must be ${LIMITS.logo} characters or fewer.`);
  }

  if ((input.description ?? "").length > LIMITS.description) {
    errors.push(`Description must be ${LIMITS.description} characters or fewer.`);
  }

  if (!Number.isInteger(input.creatorTaxBps) || input.creatorTaxBps < 0) {
    errors.push("Creator tax must be a whole number of basis points.");
  } else if (BigInt(input.creatorTaxBps) > maxCreatorTaxBps) {
    errors.push(
      `Creator tax cannot exceed ${maxCreatorTaxBps} bps ` +
        // eslint-disable-next-line no-restricted-syntax -- formatting a bps ceiling as a percentage for display only
        `(${Number(maxCreatorTaxBps) / 100}%), ` +
        `which is the protocol's current ceiling.`,
    );
  }

  if (input.devBuyAmount < 0n) errors.push("Opening buy cannot be negative.");
  if (input.devBuyAmount === 0n && input.minTokensOut > 0n) {
    errors.push("A minimum output was set but no opening buy amount was given.");
  }

  for (const [key, value] of Object.entries(input.socials ?? {})) {
    if (value !== undefined && value.length > LIMITS.social) {
      errors.push(`${key} link must be ${LIMITS.social} characters or fewer.`);
    }
    if (value !== undefined && value !== "" && !/^https?:\/\//i.test(value)) {
      errors.push(`${key} link must start with http:// or https://`);
    }
  }

  return errors;
}

/**
 * Build the launch transaction.
 *
 * Reads the live launch fee and creator-tax ceiling rather than trusting cached
 * values, because both are owner-mutable and a stale fee produces a guaranteed
 * revert on the exact-value check.
 */
export async function buildLaunchTransaction(
  client: PublicClient,
  factory: Address,
  router: Address,
  input: BuildLaunchInput,
): Promise<BuildLaunchResult> {
  const params = await readFactoryParameters(client, factory);

  // Native ETH is Pons's zero-address special case. It is not represented by the
  // ERC-20 approval mapping (the mapping reads false on-chain), while every non-native
  // candidate must pass the live membership check immediately before signing.
  if (!isNativeQuote(input.pairToken)) {
    const pairApproved = await readPairTokenApproved(client, factory, input.pairToken);
    if (!pairApproved) {
      return {
        ok: false,
        errors: [
          "The selected pair asset is not currently approved by the Pons factory. " +
            "Choose a verified pair and try again.",
        ],
      };
    }
  }

  if (!params.launchEnabled) {
    return {
      ok: false,
      errors: ["Launches are currently disabled at the protocol level by Pons."],
    };
  }

  const errors = validateLaunchInput(input, params.maxCreatorTaxBps);

  const exemptions = validateSnipeExemptions({
    addresses: input.whitelist,
    deployer: input.creator,
    ...(input.creatorFeeRecipient !== undefined
      ? { creatorFeeRecipient: input.creatorFeeRecipient }
      : {}),
  });
  errors.push(...exemptions.errors);

  if (errors.length > 0) return { ok: false, errors };

  // Pinned from the contract rather than encoded locally, so a future field addition
  // cannot silently produce a wrong pin.
  const expectedEconomics = await previewLaunchEconomics(
    client,
    factory,
    input.launchConfigId,
    input.pairToken,
  );

  const salt =
    input.salt ??
    keccak256(toHex(`stunks:${input.creator}:${input.symbol}:${Date.now()}`));

  const creatorFeeRecipient = input.creatorFeeRecipient ?? input.creator;
  const devBuyRecipient = input.devBuyRecipient ?? input.creator;

  const data = encodeFunctionData({
    abi: ponsV2LaunchAndBuyAbi,
    functionName: "launchAndBuy",
    args: [
      {
        name: input.name,
        symbol: input.symbol,
        logo: input.logo,
        description: input.description ?? "",
        socials: {
          website: input.socials?.website ?? "",
          twitter: input.socials?.twitter ?? "",
          telegram: input.socials?.telegram ?? "",
          discord: input.socials?.discord ?? "",
          farcaster: input.socials?.farcaster ?? "",
        },
        creatorFeeRecipient,
        creatorTaxBps: input.creatorTaxBps,
        buybackEnabled: input.buybackEnabled,
        expectedEconomics,
        salt,
      },
      input.launchConfigId,
      input.pairToken,
      input.devBuyAmount,
      input.minTokensOut,
      devBuyRecipient,
      exemptions.addresses,
    ],
  });

  // The exact-value rule. An ERC-20 launch must send ONLY the fee; the quote asset is
  // pulled by transferFrom, so attaching it reverts UnexpectedNativeValue.
  const value = isNativeQuote(input.pairToken)
    ? params.launchFee + input.devBuyAmount
    : params.launchFee;

  const warnings = [...exemptions.warnings];
  if (!isNativeQuote(input.pairToken) && input.devBuyAmount > 0n) {
    warnings.push(
      "This launch is paired with an ERC-20. Approve the router for the opening buy " +
        "BEFORE launching — an approval afterwards costs time inside the anti-snipe window.",
    );
  }
  if (input.logo.startsWith("http")) {
    warnings.push(
      "Using a gateway URL makes your token's on-chain metadata depend permanently on " +
        "one company's endpoint. An ipfs:// URI does not.",
    );
  }
  if (exemptions.slotsUsed > 0 && input.devBuyAmount === 0n) {
    warnings.push(
      "You declared a whitelist but no opening buy. The whitelist only helps wallets " +
        "that actually buy inside the anti-snipe window.",
    );
  }

  return {
    ok: true,
    launch: {
      to: router,
      data,
      value,
      launchFee: params.launchFee,
      expectedEconomics,
      salt,
      whitelist: exemptions.addresses,
      warnings,
    },
  };
}

/**
 * Exact value for a launch, exposed separately so a UI can show the total before
 * building the whole transaction.
 */
export function launchValue(args: {
  launchFee: bigint;
  devBuyAmount: bigint;
  pairToken: Address;
}): bigint {
  return isNativeQuote(args.pairToken)
    ? args.launchFee + args.devBuyAmount
    : args.launchFee;
}

export { MAX_DECLARABLE_SNIPE_EXEMPTIONS, NATIVE_PAIR_TOKEN };
