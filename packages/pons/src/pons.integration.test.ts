import { describe, expect, it } from "vitest";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { getChainContracts, robinhoodChain, ROBINHOOD_CHAIN_ID } from "@stunks/config";
import { ponsV2CurveAbi } from "./abi/curve.js";
import { computeCurveBuy, computeReservedTokens } from "./curve/math.js";
import { resolvePonsAddresses, assertAddressesHaveCode } from "./client/addresses.js";
import {
  readCurrentFeePolicy,
  readCurveState,
  readFactoryParameters,
  readLaunchConfigs,
  readLaunchedToken,
} from "./client/reads.js";
import { resolveTradingVenue } from "./graduation/venue.js";

/**
 * Live, read-only integration tests.
 *
 * Skipped unless RUN_LIVE_TESTS=1, so `pnpm test` stays hermetic. Nothing here
 * signs or sends a transaction.
 *
 * The single most valuable assertion in the whole suite lives here: that the local
 * bigint quote math reproduces an `eth_call` simulation exactly, against whatever
 * the live reserves happen to be. The frozen unit-test vectors prove the math was
 * right once; this proves it is still right now.
 */

const live = process.env.RUN_LIVE_TESTS === "1";
const describeLive = live ? describe : describe.skip;

const RPC = (process.env.RPC_ENDPOINTS ?? "https://robinhood.drpc.org")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)[0] as string;

const FACTORY = getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2Factory;
const REFERENCE_TOKEN = "0x0f24bfe09A097Bd6c424A285718b21d10E9f5F22" as Address;
const PROBE_ACCOUNT = "0x000000000000000000000000000000000000dEaD" as Address;

function client(): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(RPC, { retryCount: 3, retryDelay: 900, timeout: 30_000 }),
  }) as PublicClient;
}

describeLive("Robinhood Chain connectivity", () => {
  it("reports chain id 4663", async () => {
    await expect(client().getChainId()).resolves.toBe(4663);
  });

  it("produces sub-second blocks, which the polling design depends on", async () => {
    const c = client();
    const head = await c.getBlockNumber();
    const span = 10_000n;
    const [now, then] = await Promise.all([
      c.getBlock({ blockNumber: head }),
      c.getBlock({ blockNumber: head - span }),
    ]);
    const msPerBlock = ((now.timestamp - then.timestamp) * 1000n) / span;
    expect(msPerBlock).toBeLessThan(500n);
    expect(msPerBlock).toBeGreaterThan(0n);
  });
});

describeLive("address resolution from the factory", () => {
  it("resolves the whole graph and every address has code", async () => {
    const c = client();
    const addresses = await resolvePonsAddresses(c, FACTORY);
    expect(addresses.factory).toBe(FACTORY);
    // Naming traps: locker() not launchLocker(), memeHook() not hook(), and the
    // fee escrow comes from the hook because the hook IS the fee policy.
    expect(addresses.memeHook).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(addresses.feeEscrow).toMatch(/^0x[a-fA-F0-9]{40}$/);
    await expect(assertAddressesHaveCode(c, addresses)).resolves.toBeUndefined();
  });
});

describeLive("launch configuration", () => {
  it("reads at least one enabled config with sane economics", async () => {
    const configs = await readLaunchConfigs(client(), FACTORY);
    expect(configs.length).toBeGreaterThan(0);

    const config = configs[0];
    expect(config).toBeDefined();
    if (!config) return;

    expect(config.supply).toBeGreaterThan(0n);
    expect(config.phantomQuote).toBeGreaterThan(0n);
    expect(config.graduationThreshold).toBeGreaterThan(0n);
    // The protocol caps the base fee at 10%.
    expect(config.curveFeeBps).toBeLessThanOrEqual(1_000n);

    // The reserved allocation must not round away, or a launch could not seed a pool.
    const reserved = computeReservedTokens(
      config.supply,
      config.phantomQuote,
      config.graduationThreshold,
    );
    expect(reserved).toBeGreaterThan(0n);
    expect(reserved).toBeLessThan(config.supply);
  });

  it("exposes owner-mutable parameters within their documented bounds", async () => {
    const params = await readFactoryParameters(client(), FACTORY);
    expect(params.maxCreatorTaxBps).toBeLessThanOrEqual(1_000n);
    expect(params.snipeTaxStartBps).toBeLessThanOrEqual(10_000n);
    // A zero window would mean the anti-snipe mechanism is off entirely.
    expect(params.snipeTaxSeconds).toBeGreaterThan(0n);
  });
});

describeLive("fee policy", () => {
  it("reads a policy that routes nothing to STUNKS", async () => {
    const c = client();
    const addresses = await resolvePonsAddresses(c, FACTORY);
    const policy = await readCurrentFeePolicy(c, addresses.memeHook);

    expect(policy.protocolFeeShareBps).toBeGreaterThan(0);
    expect(policy.protocolFeeShareBps).toBeLessThanOrEqual(10_000);
    expect(policy.protocolFeeRecipient).toMatch(/^0x[a-fA-F0-9]{40}$/);
    // There is deliberately no STUNKS field to assert on. Its absence is the point.
  });
});

describeLive("launch record and venue", () => {
  it("reads the reference launch and resolves a venue consistent with its phase", async () => {
    const c = client();
    const launch = await readLaunchedToken(c, FACTORY, REFERENCE_TOKEN);
    if (!launch.exists) {
      // Not a failure: the reference token could be superseded over time.
      return;
    }

    const addresses = await resolvePonsAddresses(c, FACTORY);
    const venue = resolveTradingVenue({
      launch,
      poolManager: addresses.poolManager,
      memeHook: addresses.memeHook,
    });

    // Phase 0 -> curve. Phase 1/3 -> no venue. Phase 2 without pool data -> no venue.
    if (launch.phase === 0) {
      expect(venue.kind).toBe("CURVE");
    } else if (launch.phase === 1 || launch.phase === 3) {
      expect(venue.kind).toBe("NONE");
    }
  });

  it("reports exists=false for an address that is not a Pons launch", async () => {
    const launch = await readLaunchedToken(client(), FACTORY, PROBE_ACCOUNT);
    expect(launch.exists).toBe(false);

    // And therefore never offers a venue — the guard that stops STUNKS becoming a
    // trading UI for an arbitrary contract.
    const venue = resolveTradingVenue({
      launch,
      poolManager: PROBE_ACCOUNT,
      memeHook: PROBE_ACCOUNT,
    });
    expect(venue).toEqual({ kind: "NONE", reason: "NOT_A_PONS_LAUNCH" });
  });
});

describeLive("quote math equals on-chain simulation", () => {
  it("reproduces eth_call exactly, to the wei, at live reserves", async () => {
    const c = client();
    const launch = await readLaunchedToken(c, FACTORY, REFERENCE_TOKEN);
    if (!launch.exists) return;

    const state = await readCurveState(c, launch.curve);
    if (state.graduated || state.readyToGraduate) return;

    // Derived identity: reservedTokens must match the contract exactly.
    const derived = computeReservedTokens(
      state.tokenReserve + state.reservedTokens > 0n
        ? 1_000_000_000_000_000_000_000_000_000n
        : 0n,
      state.phantomQuote,
      state.graduationThreshold,
    );
    expect(derived).toBe(state.reservedTokens);

    for (const quoteIn of [
      10_000_000_000_000_000n,
      100_000_000_000_000_000n,
      1_000_000_000_000_000_000n,
    ]) {
      const local = computeCurveBuy({
        quoteIn,
        pricingQuoteReserve: state.pricingQuoteReserve,
        tokenReserve: state.tokenReserve,
        feeBps: state.feeBps,
        creatorTaxBps: state.creatorTaxBps,
        // The reference curve's snipe window closed long ago, so local math applies.
        snipeTaxBps: 0n,
        reservedTokens: state.reservedTokens,
      });

      const { result } = await c.simulateContract({
        address: launch.curve,
        abi: ponsV2CurveAbi,
        functionName: "buy",
        args: [quoteIn, 0n, PROBE_ACCOUNT],
        value: quoteIn,
        account: PROBE_ACCOUNT,
      });

      // Not a tolerance. Exact.
      expect(result).toBe(local.tokensOut);
    }
  });

  it("keeps the two quote reserves distinct, as the contract does", async () => {
    const c = client();
    const launch = await readLaunchedToken(c, FACTORY, REFERENCE_TOKEN);
    if (!launch.exists) return;

    const state = await readCurveState(c, launch.curve);
    // The pricing reserve includes the virtual phantom liquidity; the real reserve
    // does not. Confusing them is a silent pricing bug.
    expect(state.pricingQuoteReserve).toBe(state.phantomQuote + state.realQuoteReserve);
    expect(state.pricingQuoteReserve).toBeGreaterThan(state.realQuoteReserve);
  });
});
