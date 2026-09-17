import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address } from "viem";
import { ponsV2CurveAbi } from "../abi/curve.js";
import {
  MAX_BUNDLE_RECIPIENTS,
  buildBundleTransactions,
  bundleFundingRequirement,
  bundleGasCeiling,
  planBundle,
  type BundleRecipient,
  type PlanBundleArgs,
} from "./bundle.js";

/**
 * Bundle planner tests.
 *
 * The two properties worth proving here are the ones that make the feature safe rather
 * than merely functional:
 *
 *  - every enforced floor survives the WORST ordering, so a non-atomic bundle cannot
 *    half-execute on its own slippage checks
 *  - transactions cannot be built without a confirmed launch, because a buy to a
 *    codeless address does not revert and the funds are gone
 */

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const USDG = "0x4444444444444444444444444444444444444444" as Address;
const CURVE = "0x2222222222222222222222222222222222222222" as Address;
const LAUNCH_TX =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

function wallet(index: number): Address {
  return `0x${index.toString(16).padStart(40, "0")}` as Address;
}

/** Config 0 as verified on-chain: supply 1e27, phantom 1.68e18, threshold 4.2e18. */
const CONFIG_0 = {
  pricingQuoteReserve: 1_680_000_000_000_000_000n,
  tokenReserve: 1_000_000_000_000_000_000_000_000_000n,
  reservedTokens: 285_714_285_714_285_714_285_714_285n,
  feeBps: 100n,
  creatorTaxBps: 100n,
} as const;

const TENTH_ETH = 100_000_000_000_000_000n;

function args(
  recipients: readonly BundleRecipient[],
  overrides: Partial<PlanBundleArgs> = {},
): PlanBundleArgs {
  return {
    ...CONFIG_0,
    recipients,
    slippageBps: 100,
    exemptAddresses: recipients.map((r) => r.address),
    ...overrides,
  };
}

function recipients(count: number, amountIn = TENTH_ETH): BundleRecipient[] {
  return Array.from({ length: count }, (_, index) => ({
    address: wallet(index + 1),
    amountIn,
  }));
}

describe("planBundle — validation", () => {
  it("refuses an empty bundle", () => {
    const result = planBundle(args([]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_RECIPIENTS");
  });

  it("refuses more recipients than the verified 31-address exemption cap", () => {
    const list = recipients(MAX_BUNDLE_RECIPIENTS + 1, 1_000_000_000_000_000n);
    const result = planBundle(args(list));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOO_MANY_RECIPIENTS");
  });

  it("accepts exactly 31 recipients", () => {
    const list = recipients(MAX_BUNDLE_RECIPIENTS, 1_000_000_000_000_000n);
    const result = planBundle(args(list));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.buys).toHaveLength(31);
  });

  it("refuses a duplicated recipient rather than buying twice for it", () => {
    const list = [
      { address: wallet(1), amountIn: TENTH_ETH },
      { address: wallet(1), amountIn: TENTH_ETH },
    ];
    const result = planBundle(args(list));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DUPLICATE_RECIPIENT");
  });

  it("treats a differently-cased duplicate as the same wallet", () => {
    const list = [
      {
        address: "0xAbCdEf0000000000000000000000000000000001" as Address,
        amountIn: TENTH_ETH,
      },
      {
        address: "0xabcdef0000000000000000000000000000000001" as Address,
        amountIn: TENTH_ETH,
      },
    ];
    const result = planBundle(args(list));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DUPLICATE_RECIPIENT");
  });

  it("refuses a zero amount", () => {
    const result = planBundle(args([{ address: wallet(1), amountIn: 0n }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ZERO_AMOUNT");
  });

  it("refuses a recipient that is not exempt, which would pay up to 99% tax", () => {
    const list = recipients(2);
    const result = planBundle(args(list, { exemptAddresses: [wallet(1)] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_EXEMPT");
      expect(result.message).toMatch(/99%/);
    }
  });

  it("matches the exemption list case-insensitively", () => {
    const list = [
      {
        address: "0xAbCdEf0000000000000000000000000000000001" as Address,
        amountIn: TENTH_ETH,
      },
    ];
    const result = planBundle(
      args(list, {
        exemptAddresses: ["0xabcdef0000000000000000000000000000000001" as Address],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("planBundle — permutation-safe floors", () => {
  it("prices every floor below the optimistic expectation", () => {
    const result = planBundle(args(recipients(5)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const buy of result.plan.buys) {
      // The floor assumes this buy landed last, so it must be strictly lower than the
      // in-order expectation for anything but the genuinely-last buy.
      expect(buy.minOut).toBeLessThan(buy.expectedOut);
      expect(buy.minOut).toBeGreaterThan(0n);
    }
  });

  it("gives identical floors to identical amounts, regardless of position", () => {
    const result = planBundle(args(recipients(4)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Every recipient buys the same amount and each floor is priced as if it went last,
    // so all floors must be equal. Unequal floors would mean position affected
    // protection, which is exactly the bug this design avoids.
    const floors = result.plan.buys.map((buy) => buy.minOut);
    expect(new Set(floors.map(String)).size).toBe(1);
  });

  it("survives the worst ordering: the last buy still clears its own floor", () => {
    // Simulate the plan executing in reverse and check every floor holds. This is the
    // property that keeps a non-atomic bundle from half-failing.
    const result = planBundle(args(recipients(5)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reversed = [...result.plan.buys].reverse();
    let quoteReserve = CONFIG_0.pricingQuoteReserve;
    let tokenReserve = CONFIG_0.tokenReserve;

    for (const buy of reversed) {
      const fee = (buy.amountIn * CONFIG_0.feeBps) / 10_000n;
      const creator = (buy.amountIn * CONFIG_0.creatorTaxBps) / 10_000n;
      const netIn = buy.amountIn - fee - creator;
      const out = (netIn * tokenReserve) / (quoteReserve + netIn);

      expect(out).toBeGreaterThanOrEqual(buy.minOut);

      quoteReserve += netIn;
      tokenReserve -= out;
    }
  });

  it("applies slippage on top of the worst case, so a tighter tolerance raises the floor", () => {
    const loose = planBundle(args(recipients(3), { slippageBps: 500 }));
    const tight = planBundle(args(recipients(3), { slippageBps: 50 }));
    expect(loose.ok && tight.ok).toBe(true);
    if (!loose.ok || !tight.ok) return;

    expect(tight.plan.buys[0]!.minOut).toBeGreaterThan(loose.plan.buys[0]!.minOut);
  });

  it("refuses when the worst ordering would exhaust the curve", () => {
    // Amounts far past the 4.2 ETH graduation threshold.
    const result = planBundle(args(recipients(10, 10n * 10n ** 18n)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EXCEEDS_CURVE_ALLOCATION");
  });
});

describe("planBundle — totals and warnings", () => {
  it("sums the amounts the payer must provide", () => {
    const result = planBundle(args(recipients(4)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.totalIn).toBe(4n * TENTH_ETH);
  });

  it("preserves a different amount for every recipient", () => {
    const list = [
      { address: wallet(1), amountIn: 10_000_000_000_000_000n },
      { address: wallet(2), amountIn: 25_000_000_000_000_000n },
      { address: wallet(3), amountIn: 5_000_000_000_000_000n },
    ];
    const result = planBundle(args(list));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.totalIn).toBe(40_000_000_000_000_000n);
    expect(result.plan.buys.map((buy) => buy.amountIn)).toEqual(
      list.map((row) => row.amountIn),
    );

    const transactions = buildBundleTransactions(result.plan, {
      curve: CURVE,
      pairToken: NATIVE,
      launchTxHash: LAUNCH_TX,
      curveHasCode: true,
    });
    expect(transactions.transactions.map((transaction) => transaction.value)).toEqual(
      list.map((row) => row.amountIn),
    );
  });

  it("shows a decreasing expected out across the bundle, because price rises", () => {
    const result = planBundle(args(recipients(4)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const outs = result.plan.buys.map((buy) => buy.expectedOut);
    for (let i = 1; i < outs.length; i++) {
      expect(outs[i]!).toBeLessThan(outs[i - 1]!);
    }
  });

  it("warns honestly that a large bundle cannot all land inside a ~3s window", () => {
    const result = planBundle(args(recipients(12, 10_000_000_000_000_000n)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.warnings.join(" ")).toMatch(/anti-snipe window/i);
  });

  it("does not warn for a small bundle", () => {
    const result = planBundle(args(recipients(3)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.warnings).toHaveLength(0);
  });
});

describe("buildBundleTransactions — the R17 gate", () => {
  const plan = (() => {
    const result = planBundle(args(recipients(3)));
    if (!result.ok) throw new Error("fixture plan should succeed");
    return result.plan;
  })();

  it("refuses to build when the curve has no code, which would strand the funds", () => {
    expect(() =>
      buildBundleTransactions(plan, {
        curve: CURVE,
        pairToken: NATIVE,
        launchTxHash: LAUNCH_TX,
        curveHasCode: false,
      }),
    ).toThrow(/no code yet/i);
  });

  it("builds against the curve from the receipt for a native launch", () => {
    const bundle = buildBundleTransactions(plan, {
      curve: CURVE,
      pairToken: NATIVE,
      launchTxHash: LAUNCH_TX,
      curveHasCode: true,
    });

    expect(bundle.native).toBe(true);
    expect(bundle.transactions).toHaveLength(3);
    for (const tx of bundle.transactions) {
      expect(tx.to).toBe(CURVE);
      // Native: msg.value must equal the buy amount exactly.
      expect(tx.value).toBe(TENTH_ETH);
    }
  });

  it("sends zero value for an ERC-20 quoted launch", () => {
    const bundle = buildBundleTransactions(plan, {
      curve: CURVE,
      pairToken: USDG,
      launchTxHash: LAUNCH_TX,
      curveHasCode: true,
    });
    expect(bundle.native).toBe(false);
    for (const tx of bundle.transactions) expect(tx.value).toBe(0n);
  });

  it("encodes buy(amount, minOut, recipient) with each wallet as its own recipient", () => {
    const bundle = buildBundleTransactions(plan, {
      curve: CURVE,
      pairToken: NATIVE,
      launchTxHash: LAUNCH_TX,
      curveHasCode: true,
    });

    bundle.transactions.forEach((tx, index) => {
      const decoded = decodeFunctionData({ abi: ponsV2CurveAbi, data: tx.data });
      expect(decoded.functionName).toBe("buy");
      const decodedArgs = decoded.args as readonly [bigint, bigint, Address];
      expect(decodedArgs[0]).toBe(plan.buys[index]!.amountIn);
      expect(decodedArgs[1]).toBe(plan.buys[index]!.minOut);
      expect(decodedArgs[2]).toBe(plan.buys[index]!.recipient);
    });
  });

  it("preserves submission order, which is what nonce ordering relies on", () => {
    const bundle = buildBundleTransactions(plan, {
      curve: CURVE,
      pairToken: NATIVE,
      launchTxHash: LAUNCH_TX,
      curveHasCode: true,
    });
    expect(bundle.transactions.map((tx) => tx.order)).toEqual([0, 1, 2]);
  });
});

describe("gas and funding", () => {
  it("bids well above base fee, because losing the window loses the feature", () => {
    const ceiling = bundleGasCeiling(1_000_000_000n, 100_000_000n);
    expect(ceiling.maxFeePerGas).toBe(6_100_000_000n);
    expect(ceiling.maxPriorityFeePerGas).toBe(100_000_000n);
  });

  it("counts the buys and the gas against one balance for a native launch", () => {
    const result = planBundle(args(recipients(3)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const funding = bundleFundingRequirement({
      plan: result.plan,
      native: true,
      gasPerBuy: 200_000n,
      maxFeePerGas: 6_100_000_000n,
    });

    const gas = 3n * 200_000n * 6_100_000_000n;
    expect(funding.quoteAsset).toBe(3n * TENTH_ETH);
    // Native: the same wallet pays for both, so the requirement includes the buys.
    expect(funding.nativeForGas).toBe(gas + 3n * TENTH_ETH);
  });

  it("separates gas from the quote asset for an ERC-20 launch", () => {
    const result = planBundle(args(recipients(3)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const funding = bundleFundingRequirement({
      plan: result.plan,
      native: false,
      gasPerBuy: 200_000n,
      maxFeePerGas: 6_100_000_000n,
    });
    expect(funding.nativeForGas).toBe(3n * 200_000n * 6_100_000_000n);
    expect(funding.quoteAsset).toBe(3n * TENTH_ETH);
  });
});
