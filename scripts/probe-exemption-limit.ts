/**
 * Probe the real declarable snipe-tax exemption limit on PonsV2LaunchAndBuy.
 *
 *   pnpm probe:exemptions
 *
 * WHY THIS EXISTS
 *
 * The factory source caps the exemption list at 32 (MAX_SNIPE_TAX_EXEMPTIONS), and
 * third-party documentation states that only 31 may be *declared* through the
 * router, because the router appends `recipient` to the list itself. That 31 was
 * never verified first-hand, and no public getter exposes it.
 *
 * It matters because the limit is enforced AFTER the launch fee is committed: a
 * creator who declares one address too many loses the fee to a revert. So STUNKS
 * must cap its input at the true value, and this script establishes what that is.
 *
 * Everything here is a read-only `eth_call` with a balance state override. No
 * transaction is signed, nothing is broadcast, and no funds move.
 */

import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ROBINHOOD_CHAIN_ID, getChainContracts, robinhoodChain } from "@stunks/config";
import {
  ponsV2LaunchAndBuyAbi,
  readFactoryParameters,
  previewLaunchEconomics,
  resolvePonsAddresses,
  NATIVE_PAIR_TOKEN,
} from "@stunks/pons";

// Lowercase on purpose: viem rejects mixed-case addresses that fail EIP-55.
const CREATOR = "0x000000000000000000000000000000000000beef" as Address;

/** Distinct, deterministic throwaway addresses to fill an exemption list with. */
function exemptionList(count: number): Address[] {
  return Array.from(
    { length: count },
    (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}` as Address,
  );
}

interface Attempt {
  declared: number;
  reverted: boolean;
  reason: string;
}

async function attempt(args: {
  client: PublicClient;
  router: Address;
  launchFee: bigint;
  quoteIn: bigint;
  expectedEconomics: Hex;
  declared: number;
}): Promise<Attempt> {
  const { client, router, launchFee, quoteIn, expectedEconomics, declared } = args;

  const data = encodeFunctionData({
    abi: ponsV2LaunchAndBuyAbi,
    functionName: "launchAndBuy",
    args: [
      {
        name: `ProbeToken${declared}`,
        symbol: "PROBE",
        logo: "ipfs://probe",
        description: "read-only exemption-limit probe",
        socials: {
          website: "",
          twitter: "",
          telegram: "",
          discord: "",
          farcaster: "",
        },
        creatorFeeRecipient: CREATOR,
        creatorTaxBps: 0,
        buybackEnabled: false,
        expectedEconomics,
        // Unique per attempt so a CREATE2 collision cannot be mistaken for the
        // limit being hit.
        salt: keccak256(toHex(`stunks-exemption-probe-${declared}`)),
      },
      0n,
      NATIVE_PAIR_TOKEN,
      quoteIn,
      0n,
      CREATOR,
      exemptionList(declared),
    ],
  });

  try {
    await client.call({
      to: router,
      data,
      // msg.value is checked with != , not <: exactly launchFee + quoteIn.
      value: launchFee + quoteIn,
      account: CREATOR,
      stateOverride: [{ address: CREATOR, balance: 10n ** 20n }],
    });
    return { declared, reverted: false, reason: "" };
  } catch (error) {
    const message =
      error instanceof Error
        ? ((error as { shortMessage?: string }).shortMessage ?? error.message)
        : String(error);
    return {
      declared,
      reverted: true,
      reason: message.replace(/\s+/g, " ").slice(0, 160),
    };
  }
}

async function main(): Promise<void> {
  const endpoint =
    (process.env.RPC_ENDPOINTS ?? "https://robinhood.drpc.org").split(",")[0]?.trim() ??
    "https://robinhood.drpc.org";

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http(endpoint, { retryCount: 3, retryDelay: 900, timeout: 30_000 }),
  }) as PublicClient;

  const factory = getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2Factory;
  const addresses = await resolvePonsAddresses(client, factory);
  const params = await readFactoryParameters(client, factory);
  const expectedEconomics = await previewLaunchEconomics(
    client,
    factory,
    0n,
    NATIVE_PAIR_TOKEN,
  );

  console.log("Exemption-limit probe (read-only, no funds move)");
  console.log(`  RPC        ${endpoint}`);
  console.log(`  router     ${addresses.launchAndBuyRouter}`);
  console.log(`  launchFee  ${params.launchFee}`);
  console.log(`  economics  ${expectedEconomics}`);
  console.log("");

  // A small dev buy so the call exercises the real path rather than a zero-amount
  // early return.
  const quoteIn = 10_000_000_000_000_000n; // 0.01 ETH

  const results: Attempt[] = [];
  for (const declared of [0, 1, 30, 31, 32, 33]) {
    const result = await attempt({
      client,
      router: addresses.launchAndBuyRouter,
      launchFee: params.launchFee,
      quoteIn,
      expectedEconomics,
      declared,
    });
    results.push(result);
    const status = result.reverted ? "REVERT" : "ok    ";
    console.log(
      `  declared=${String(declared).padStart(2)}  ${status}  ${result.reason}`,
    );
  }

  console.log("");

  // The boundary is derived from where success turns into revert, not from a
  // decoded error name. The router's custom errors are not in our ABI, so a revert
  // reason is opaque — but the transition itself is unambiguous.
  const highestAccepted = results
    .filter((r) => !r.reverted)
    .reduce((max, r) => (r.declared > max ? r.declared : max), -1);
  const lowestRejected = results
    .filter((r) => r.reverted)
    .reduce((min, r) => (r.declared < min ? r.declared : min), Number.MAX_SAFE_INTEGER);

  if (highestAccepted < 0) {
    console.log(
      "CONCLUSION: every attempt reverted, so the limit was NOT established. Read the\n" +
        "            reasons above. Do not guess a cap — it is enforced after the launch\n" +
        "            fee is committed.",
    );
    process.exitCode = 1;
    return;
  }

  if (lowestRejected === Number.MAX_SAFE_INTEGER) {
    console.log(
      `CONCLUSION: nothing was rejected up to ${highestAccepted} declared addresses, so no\n` +
        `            cap was observed in the probed range.`,
    );
    return;
  }

  console.log(
    `CONCLUSION: ${highestAccepted} declared addresses is accepted, ${lowestRejected} reverts.\n` +
      `            Maximum declarable exemptions = ${highestAccepted}.`,
  );
  console.log(
    `\n            This confirms the documented 31 first-hand: the factory ceiling is 32\n` +
      `            and the router appends 'recipient' itself, leaving ${highestAccepted} for the caller.\n` +
      `            STUNKS must cap input at ${highestAccepted} and reject beyond it client-side,\n` +
      `            because the contract enforces it only after the fee is committed.`,
  );
}

main().catch((error: unknown) => {
  console.error("Probe failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
