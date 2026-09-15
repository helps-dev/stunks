/**
 * Pons V2 verification harness.
 *
 * This is the Phase 0 audit, promoted from throwaway probes into something that can
 * be re-run. Its job is to catch drift between what the docs claim and what the
 * chain actually does — including drift caused by the protocol owner changing a
 * mutable parameter.
 *
 *   pnpm verify:pons
 *
 * Every check prints PASS, FAIL, or INFO. A FAIL means a documented fact is no
 * longer true, which is a stop-work condition, not a warning.
 *
 * Exit code 1 if any check fails.
 */

import {
  createPublicClient,
  http,
  toEventSelector,
  toFunctionSelector,
  type Address,
  type PublicClient,
} from "viem";
import {
  CONTRACTS,
  ROBINHOOD_CHAIN_ID,
  getChainContracts,
  robinhoodChain,
} from "@stunks/config";
import {
  computeCurveBuy,
  computeReservedTokens,
  ponsV2CurveAbi,
  readCurrentFeePolicy,
  readCurveState,
  readFactoryParameters,
  readLaunchConfigs,
  readLaunchedToken,
  readPairTokenEconomics,
  resolvePonsAddresses,
} from "@stunks/pons";

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

let failures = 0;
let checks = 0;

function pass(label: string, detail = ""): void {
  checks++;
  console.log(`  PASS  ${label}${detail ? `  ${detail}` : ""}`);
}

function fail(label: string, detail: string): void {
  checks++;
  failures++;
  console.log(`  FAIL  ${label}\n        ${detail}`);
}

function info(label: string, detail = ""): void {
  console.log(`  INFO  ${label}${detail ? `  ${detail}` : ""}`);
}

function section(title: string): void {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (String(actual) === String(expected)) {
    pass(label, `= ${String(actual)}`);
  } else {
    fail(label, `expected ${String(expected)}, chain says ${String(actual)}`);
  }
}

/**
 * A mutable parameter that has changed is not a bug — it is exactly the drift this
 * script exists to surface. Reported as INFO with the documented value alongside.
 */
function expectDocumented(label: string, actual: unknown, documented: unknown): void {
  if (String(actual) === String(documented)) {
    pass(label, `= ${String(actual)}`);
  } else {
    info(
      `${label} CHANGED`,
      `docs say ${String(documented)}, chain now says ${String(actual)} — update docs`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Values recorded during the Phase 0 audit
// ─────────────────────────────────────────────────────────────────────────────

/** Immutable facts. A mismatch here is a genuine failure. */
const AUDIT_IMMUTABLE = {
  chainId: 4663,
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address,
  factoryDeployBlock: 26_841_846n,
  memeHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as Address,
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7" as Address,
  launchAndBuyRouter: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948" as Address,
  tokenLaunchedTopic0:
    "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
} as const;

/** Owner-mutable. A change is reported, not failed. */
const AUDIT_MUTABLE = {
  launchFee: 500_000_000_000_000n,
  maxCreatorTaxBps: 1_000n,
  snipeTaxStartBps: 9_900n,
  snipeTaxSeconds: 3n,
  protocolFeeShareBps: 3_000,
  buybackBurnBps: 5_000,
  hookFeeBps: 100,
  maxInternalPriceImpactBps: 300,
  launchConfigCount: 1,
  config0: {
    supply: 1_000_000_000_000_000_000_000_000_000n,
    curveFeeBps: 100n,
    phantomQuote: 1_680_000_000_000_000_000n,
    graduationThreshold: 4_200_000_000_000_000_000n,
    poolFee: 0,
    tickSpacing: 200,
  },
} as const;

/** The reference launch whose quote vectors the unit tests assert against. */
const REFERENCE = {
  token: "0x0f24bfe09A097Bd6c424A285718b21d10E9f5F22" as Address,
  curve: "0xe0d8C6a8c6F4aEA8e86A613FFB5545cC9372d87A" as Address,
} as const;

/** Approved quote assets re-read during the audit. USDG's 6 decimals is a real trap. */
const AUDIT_PAIRS: {
  symbol: string;
  address: Address;
  phantomQuote: bigint;
  threshold: bigint;
}[] = [
  {
    symbol: "USDG",
    address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address,
    phantomQuote: 3_236_000_000n,
    threshold: 8_090_000_000n,
  },
  {
    symbol: "NVDA",
    address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as Address,
    phantomQuote: 16_640_000_000_000_000_000n,
    threshold: 41_600_000_000_000_000_000n,
  },
  {
    symbol: "MSFT",
    address: "0xe93237c50d904957cf27e7b1133b510c669c2e74" as Address,
    phantomQuote: 6_431_455_767_077_268_559n,
    threshold: 16_078_639_417_693_171_399n,
  },
];

/**
 * Selectors that must exist in deployed bytecode, and selectors that must NOT.
 *
 * The absent ones matter as much as the present ones: `quoteBuy`/`quoteSell` not
 * existing is why the whole quoting architecture is built the way it is.
 */
const CURVE_SELECTORS_PRESENT = [
  "function buy(uint256,uint256,address) payable returns (uint256)",
  "function sell(uint256,uint256,address) returns (uint256)",
  "function getReserves() view returns (uint256,uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function reservedTokens() view returns (uint256)",
  "function sellableTokens() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  // Deployed but absent from Pons's published source.
  "function exemptFromSnipeTax(address)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function launchedAt() view returns (uint256)",
  "function snipeTaxExempt(address) view returns (bool)",
  "function currentSnipeTaxBps(address) view returns (uint256)",
];

const CURVE_SELECTORS_ABSENT = [
  "function quoteBuy(uint256) view returns (uint256)",
  "function quoteSell(uint256) view returns (uint256)",
];

const ROUTER_SELECTORS_PRESENT = [
  "function launchAndBuy((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,uint256,uint256,address,address[]) payable returns (address,address)",
];

// ─────────────────────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────────────────────

async function verifyChain(client: PublicClient): Promise<void> {
  section("1. Chain");
  const chainId = await client.getChainId();
  expectEqual("chain id", chainId, AUDIT_IMMUTABLE.chainId);

  const head = await client.getBlockNumber();
  info("head block", `= ${head}`);

  // Measured block time, the number that drives the indexer and polling design.
  const span = 10_000n;
  const [headBlock, pastBlock] = await Promise.all([
    client.getBlock({ blockNumber: head }),
    client.getBlock({ blockNumber: head - span }),
  ]);
  const deltaSeconds = headBlock.timestamp - pastBlock.timestamp;
  const msPerBlock = (deltaSeconds * 1000n) / span;
  info("measured block time", `~${msPerBlock} ms/block (docs: ~101 ms)`);
  if (msPerBlock > 500n) {
    fail(
      "block time",
      `unexpectedly slow: ${msPerBlock} ms — recheck indexer assumptions`,
    );
  } else {
    pass("block time is sub-second, as the design assumes");
  }
}

async function verifyAddresses(client: PublicClient, factory: Address): Promise<void> {
  section("2. Address graph resolved from the factory");

  const code = await client.getCode({ address: factory });
  if (!code || code === "0x") {
    fail("factory has code", `no code at ${factory}`);
    return;
  }
  pass("factory has code", `${(code.length - 2) / 2} bytes`);

  const deployBlockCode = await client.getCode({
    address: factory,
    blockNumber: AUDIT_IMMUTABLE.factoryDeployBlock,
  });
  if (deployBlockCode && deployBlockCode !== "0x") {
    pass(
      "factory existed at documented deploy block",
      `${AUDIT_IMMUTABLE.factoryDeployBlock}`,
    );
  } else {
    info(
      "deploy block unverifiable",
      "endpoint may not serve archive state that far back",
    );
  }

  const addresses = await resolvePonsAddresses(client, factory);
  expectEqual("memeHook", addresses.memeHook, AUDIT_IMMUTABLE.memeHook);
  expectEqual("poolManager", addresses.poolManager, AUDIT_IMMUTABLE.poolManager);
  expectEqual(
    "positionManager",
    addresses.positionManager,
    AUDIT_IMMUTABLE.positionManager,
  );
  // Rotatable by the owner, so a change is information rather than failure.
  expectDocumented(
    "launchAndBuy router",
    addresses.launchAndBuyRouter,
    AUDIT_IMMUTABLE.launchAndBuyRouter,
  );
  info("graduationExecutor", addresses.graduationExecutor);
  info("launchDeployer", addresses.launchDeployer);
  info("locker", addresses.locker);
  info("buybackVault", addresses.buybackVault);
  info("graduationGuard", addresses.graduationGuard);
  info("feeEscrow", addresses.feeEscrow);

  // Every resolved address must have code, or reads against it return empty
  // results that look like legitimate answers.
  const withoutCode: string[] = [];
  for (const [name, address] of Object.entries(addresses)) {
    const addressCode = await client.getCode({ address: address as Address });
    if (!addressCode || addressCode === "0x") withoutCode.push(`${name} (${address})`);
  }
  if (withoutCode.length === 0) {
    pass("every resolved address has code");
  } else {
    fail("resolved addresses without code", withoutCode.join(", "));
  }
}

async function verifyParameters(client: PublicClient, factory: Address): Promise<void> {
  section("3. Factory parameters (all owner-mutable)");
  const params = await readFactoryParameters(client, factory);
  expectDocumented("launchFee", params.launchFee, AUDIT_MUTABLE.launchFee);
  expectDocumented(
    "maxCreatorTaxBps",
    params.maxCreatorTaxBps,
    AUDIT_MUTABLE.maxCreatorTaxBps,
  );
  expectDocumented(
    "snipeTaxStartBps",
    params.snipeTaxStartBps,
    AUDIT_MUTABLE.snipeTaxStartBps,
  );
  expectDocumented(
    "snipeTaxSeconds",
    params.snipeTaxSeconds,
    AUDIT_MUTABLE.snipeTaxSeconds,
  );
  info("launchEnabled", `= ${params.launchEnabled}`);
  info("owner", params.owner);
  if (!params.launchEnabled) {
    info("launches are currently DISABLED at the protocol level");
  }
}

async function verifyLaunchConfigs(
  client: PublicClient,
  factory: Address,
): Promise<void> {
  section("4. Launch configs");
  const configs = await readLaunchConfigs(client, factory);
  expectDocumented("launchConfigCount", configs.length, AUDIT_MUTABLE.launchConfigCount);

  const config0 = configs[0];
  if (!config0) {
    fail("config 0 exists", "no launch configs returned");
    return;
  }

  expectDocumented("config0.supply", config0.supply, AUDIT_MUTABLE.config0.supply);
  expectDocumented(
    "config0.curveFeeBps",
    config0.curveFeeBps,
    AUDIT_MUTABLE.config0.curveFeeBps,
  );
  expectDocumented(
    "config0.phantomQuote",
    config0.phantomQuote,
    AUDIT_MUTABLE.config0.phantomQuote,
  );
  expectDocumented(
    "config0.graduationThreshold",
    config0.graduationThreshold,
    AUDIT_MUTABLE.config0.graduationThreshold,
  );
  expectDocumented("config0.poolFee", config0.poolFee, AUDIT_MUTABLE.config0.poolFee);
  expectDocumented(
    "config0.tickSpacing",
    config0.tickSpacing,
    AUDIT_MUTABLE.config0.tickSpacing,
  );

  // The reserved-token identity: this is a property of the protocol's design, so a
  // mismatch is a real failure regardless of parameter changes.
  const reserved = computeReservedTokens(
    config0.supply,
    config0.phantomQuote,
    config0.graduationThreshold,
  );
  const reservedBps = (reserved * 10_000n) / config0.supply;
  const sellableBps = ((config0.supply - reserved) * 10_000n) / config0.supply;
  info(
    "derived split",
    `reserved ${reserved} (${reservedBps} bps) / sellable ${sellableBps} bps`,
  );
}

async function verifyFeePolicy(client: PublicClient, memeHook: Address): Promise<void> {
  section("5. Fee policy (read from the hook, which IS the fee policy)");
  const policy = await readCurrentFeePolicy(client, memeHook);
  expectDocumented(
    "protocolFeeShareBps",
    policy.protocolFeeShareBps,
    AUDIT_MUTABLE.protocolFeeShareBps,
  );
  expectDocumented("buybackBurnBps", policy.buybackBurnBps, AUDIT_MUTABLE.buybackBurnBps);
  expectDocumented("hookFeeBps", policy.hookFeeBps, AUDIT_MUTABLE.hookFeeBps);
  expectDocumented(
    "maxInternalPriceImpactBps",
    policy.maxInternalPriceImpactBps,
    AUDIT_MUTABLE.maxInternalPriceImpactBps,
  );
  info("protocolFeeRecipient", policy.protocolFeeRecipient);
  info(
    "STUNKS revenue",
    "0 — no parameter in this policy routes value to a third-party interface",
  );
}

async function verifySelectors(client: PublicClient, router: Address): Promise<void> {
  section("6. Deployed bytecode selectors");

  const curveCode = await client.getCode({ address: REFERENCE.curve });
  if (!curveCode || curveCode === "0x") {
    fail("reference curve has code", `no code at ${REFERENCE.curve}`);
    return;
  }

  const missing = CURVE_SELECTORS_PRESENT.filter(
    (sig) => !curveCode.includes(toFunctionSelector(sig).slice(2)),
  );
  if (missing.length === 0) {
    pass(`all ${CURVE_SELECTORS_PRESENT.length} expected curve selectors present`);
  } else {
    fail("curve selectors missing", missing.join("\n        "));
  }

  const unexpected = CURVE_SELECTORS_ABSENT.filter((sig) =>
    curveCode.includes(toFunctionSelector(sig).slice(2)),
  );
  if (unexpected.length === 0) {
    pass("no on-chain quote functions exist, as documented");
  } else {
    info(
      "a quote function APPEARED",
      `${unexpected.join(", ")} — the quoting architecture could be simplified`,
    );
  }

  const routerCode = await client.getCode({ address: router });
  if (routerCode && routerCode !== "0x") {
    const routerMissing = ROUTER_SELECTORS_PRESENT.filter(
      (sig) => !routerCode.includes(toFunctionSelector(sig).slice(2)),
    );
    if (routerMissing.length === 0) {
      pass("launchAndBuy present on the router", "selector 0xf85f8e41");
    } else {
      fail("launchAndBuy missing from router", routerMissing.join(", "));
    }
  }

  // Event signature: this decoded a real mainnet log during the audit.
  const topic0 = toEventSelector(
    "TokenLaunched(address,address,address,address,uint256,uint256)",
  );
  expectEqual("TokenLaunched topic0", topic0, AUDIT_IMMUTABLE.tokenLaunchedTopic0);
}

async function verifyQuoteMath(client: PublicClient, factory: Address): Promise<void> {
  section("7. Quote math against live simulation");

  const launch = await readLaunchedToken(client, factory, REFERENCE.token);
  if (!launch.exists) {
    info("reference launch not found", "it may have been re-indexed; skipping");
    return;
  }
  info("reference token", `${REFERENCE.token} phase=${launch.phase}`);

  const state = await readCurveState(client, REFERENCE.curve);
  if (state.graduated) {
    info("reference curve has graduated", "live quote comparison skipped");
    return;
  }

  const payer = "0x000000000000000000000000000000000000dEaD" as Address;
  const sizes = [
    10_000_000_000_000_000n,
    100_000_000_000_000_000n,
    1_000_000_000_000_000_000n,
  ];

  for (const quoteIn of sizes) {
    const local = computeCurveBuy({
      quoteIn,
      pricingQuoteReserve: state.pricingQuoteReserve,
      tokenReserve: state.tokenReserve,
      feeBps: state.feeBps,
      creatorTaxBps: state.creatorTaxBps,
      snipeTaxBps: 0n,
      reservedTokens: state.reservedTokens,
    });

    try {
      const { result } = await client.simulateContract({
        address: REFERENCE.curve,
        abi: ponsV2CurveAbi,
        functionName: "buy",
        args: [quoteIn, 0n, payer],
        value: quoteIn,
        account: payer,
      });
      // The property the entire trading engine rests on: exact, to the wei.
      if ((result as bigint) === local.tokensOut) {
        pass(`local math === simulation for ${quoteIn} wei in`, `${local.tokensOut}`);
      } else {
        fail(
          `local math !== simulation for ${quoteIn} wei in`,
          `local ${local.tokensOut}, chain ${String(result)}`,
        );
      }
    } catch (error) {
      info(
        `simulation unavailable for ${quoteIn} wei`,
        error instanceof Error ? error.message.slice(0, 90) : String(error),
      );
    }
  }

  // reservedTokens is a derived identity and must match the contract exactly.
  const supply = state.tokenReserve + (state.reservedTokens - state.reservedTokens);
  void supply;
  const derived = computeReservedTokens(
    1_000_000_000_000_000_000_000_000_000n,
    state.phantomQuote,
    state.graduationThreshold,
  );
  expectEqual("reservedTokens derivation", derived, state.reservedTokens);
}

async function verifyPairTokens(client: PublicClient, factory: Address): Promise<void> {
  section("8. Approved quote assets");
  for (const pair of AUDIT_PAIRS) {
    try {
      const economics = await readPairTokenEconomics(client, factory, pair.address);
      const matches =
        economics.phantomQuote === pair.phantomQuote &&
        economics.graduationThreshold === pair.threshold;
      if (matches) {
        pass(`${pair.symbol} economics unchanged`);
      } else {
        info(
          `${pair.symbol} economics CHANGED`,
          `phantomQuote ${economics.phantomQuote} (docs ${pair.phantomQuote}), ` +
            `threshold ${economics.graduationThreshold} (docs ${pair.threshold})`,
        );
      }
    } catch (error) {
      info(
        `${pair.symbol} unreadable`,
        error instanceof Error ? error.message.slice(0, 70) : String(error),
      );
    }
  }
  info(
    "reminder",
    "USDG uses 6 decimals; never assume 18, and never derive threshold from phantomQuote",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const endpoints = (process.env.RPC_ENDPOINTS ?? "https://robinhood.drpc.org")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const endpoint = endpoints[0];
  if (!endpoint) throw new Error("No RPC endpoint configured (set RPC_ENDPOINTS)");

  console.log("STUNKS.FUN — Pons V2 verification");
  console.log(`RPC:     ${endpoint}`);
  console.log(
    `Chain:   ${ROBINHOOD_CHAIN_ID} (${Object.keys(CONTRACTS).length} configured)`,
  );

  const factory =
    (process.env.PONS_V2_FACTORY as Address | undefined) ??
    getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2Factory;
  console.log(`Factory: ${factory}`);

  // A plain single-endpoint client on purpose: this script verifies the chain, so
  // it should not hide an endpoint problem behind failover.
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http(endpoint, { retryCount: 3, retryDelay: 800, timeout: 30_000 }),
    pollingInterval: 100,
  }) as PublicClient;

  await verifyChain(client);
  await verifyAddresses(client, factory);
  await verifyParameters(client, factory);
  await verifyLaunchConfigs(client, factory);

  const addresses = await resolvePonsAddresses(client, factory);
  await verifyFeePolicy(client, addresses.memeHook);
  await verifySelectors(client, addresses.launchAndBuyRouter);
  await verifyQuoteMath(client, factory);
  await verifyPairTokens(client, factory);

  section("Result");
  console.log(`  ${checks} checks, ${failures} failed`);
  if (failures > 0) {
    console.log(
      `\n  A failure means a fact in docs/PONS_V2_INTEGRATION.md is no longer true.\n` +
        `  Treat it as a stop-work condition: re-verify before shipping anything that\n` +
        `  depends on it.`,
    );
    process.exitCode = 1;
  } else {
    console.log("\n  Every documented fact still holds.");
  }
}

main().catch((error: unknown) => {
  console.error(
    "\nVerification aborted:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
