import { encodeFunctionData, type Address, type Hex } from "viem";
import { applySlippageFloor } from "@stunks/utils";
import { ponsV2CurveAbi } from "../abi/curve.js";
import { computeCurveBuy, SnipeTaxNotModellableError } from "../curve/math.js";
import { decodePonsLog } from "../events/index.js";

/**
 * Whitelist bundle buy planner.
 *
 * The feature: a creator launches, and the wallets they whitelisted get their tokens
 * before an outside sniper can. Pons already provides the mechanism — addresses in the
 * launch's exemption list pay no anti-snipe tax, while everyone else pays 99% for the
 * first ~3 seconds. STUNKS' job is to turn that mechanism into buys that actually land
 * inside the window.
 *
 * Design decision: SEQUENTIAL BUYS FROM ONE PAYER, not one transaction per whitelisted
 * wallet. `curve.buy(amount, minOut, recipient)` credits an arbitrary recipient, so a
 * single funded wallet can buy for all 31 addresses. Those wallets need no ETH at all,
 * which removes the pre-funding step that would otherwise have to happen before the
 * launch and would telegraph it.
 *
 * Three hazards this planner exists to handle, all of them verified rather than assumed:
 *
 * 1. A BUY TO A NOT-YET-DEPLOYED CURVE DOES NOT REVERT. It succeeds as a plain value
 *    transfer to a codeless address and the ETH is simply gone (risk R17). So the plan
 *    carries no curve address at all until a launch receipt supplies one — the type makes
 *    a premature broadcast impossible rather than merely discouraged.
 *
 * 2. ORDER IS NOT GUARANTEED. Sequential submission from one wallet gives sequential
 *    nonces, so ordering holds within the wallet — but a bundle is not atomic and an
 *    outsider's buy can interleave. Every recipient's floor is therefore priced as if it
 *    landed LAST, behind every other buy in the bundle. A floor priced on the current
 *    reserve would revert for everyone except the first.
 *
 * 3. THE WINDOW IS ~3 SECONDS. Not a design input to be tuned; it is `snipeTaxSeconds`
 *    read from the curve. The plan reports how many buys can realistically be submitted
 *    inside it rather than promising all of them.
 */

export interface BundleRecipient {
  readonly address: Address;
  /** Quote-asset amount to spend for this recipient. */
  readonly amountIn: bigint;
}

export interface PlanBundleArgs {
  readonly recipients: readonly BundleRecipient[];
  /** Curve state as of the launch, before any bundle buy has landed. */
  readonly pricingQuoteReserve: bigint;
  readonly tokenReserve: bigint;
  readonly reservedTokens: bigint;
  readonly feeBps: bigint;
  readonly creatorTaxBps: bigint;
  readonly slippageBps: number;
  /** From the launch's exemption list. Non-exempt recipients are refused. */
  readonly exemptAddresses: readonly Address[];
}

export interface PlannedBuy {
  readonly recipient: Address;
  readonly amountIn: bigint;
  /** Expected out if this buy landed first. Shown, never enforced. */
  readonly expectedOut: bigint;
  /**
   * Enforced floor, priced as if every other buy in the bundle landed first. This is
   * what goes on-chain.
   */
  readonly minOut: bigint;
  readonly order: number;
}

export interface BundlePlan {
  readonly buys: readonly PlannedBuy[];
  readonly totalIn: bigint;
  /** Total the payer must hold, quote asset. Gas is separate and not included. */
  readonly totalExpectedOut: bigint;
  readonly warnings: readonly string[];
}

export type PlanBundleResult =
  | { readonly ok: true; readonly plan: BundlePlan }
  | { readonly ok: false; readonly code: BundleRefusal; readonly message: string };

export type BundleRefusal =
  | "NO_RECIPIENTS"
  | "TOO_MANY_RECIPIENTS"
  | "DUPLICATE_RECIPIENT"
  | "NOT_EXEMPT"
  | "ZERO_AMOUNT"
  | "EXCEEDS_CURVE_ALLOCATION"
  | "NOT_MODELLABLE";

/**
 * Verified cap. The factory reverts with `ExemptionListTooLong` above 31 addresses —
 * established first-hand, not read from a document.
 */
export const MAX_BUNDLE_RECIPIENTS = 31;

export function planBundle(args: PlanBundleArgs): PlanBundleResult {
  const { recipients, slippageBps, exemptAddresses } = args;

  if (recipients.length === 0) {
    return {
      ok: false,
      code: "NO_RECIPIENTS",
      message: "Add at least one wallet to bundle.",
    };
  }
  if (recipients.length > MAX_BUNDLE_RECIPIENTS) {
    return {
      ok: false,
      code: "TOO_MANY_RECIPIENTS",
      message:
        `A launch can exempt at most ${MAX_BUNDLE_RECIPIENTS} addresses, so a bundle cannot ` +
        `exceed that either. You listed ${recipients.length}.`,
    };
  }

  const seen = new Set<string>();
  for (const recipient of recipients) {
    const key = recipient.address.toLowerCase();
    if (seen.has(key)) {
      return {
        ok: false,
        code: "DUPLICATE_RECIPIENT",
        message: `${recipient.address} appears more than once. Combine the amounts instead.`,
      };
    }
    seen.add(key);
    if (recipient.amountIn <= 0n) {
      return {
        ok: false,
        code: "ZERO_AMOUNT",
        message: `Set an amount greater than zero for ${recipient.address}.`,
      };
    }
  }

  // Every recipient must be exempt, or the bundle defeats its own purpose: a
  // non-exempt buy inside the window pays up to 99% tax.
  const exempt = new Set(exemptAddresses.map((address) => address.toLowerCase()));
  for (const recipient of recipients) {
    if (!exempt.has(recipient.address.toLowerCase())) {
      return {
        ok: false,
        code: "NOT_EXEMPT",
        message:
          `${recipient.address} is not in the launch's exemption list, so it would pay the ` +
          `anti-snipe tax — up to 99% of the buy. Add it to the whitelist at launch, or ` +
          `remove it from the bundle.`,
      };
    }
  }

  const buys: PlannedBuy[] = [];
  const warnings: string[] = [];
  let totalIn = 0n;
  let totalExpectedOut = 0n;

  // ── Expected out: each buy priced against the reserve it will actually see, in
  //    submission order. This is the optimistic case and it is what gets displayed.
  let quoteReserve = args.pricingQuoteReserve;
  let tokenReserve = args.tokenReserve;

  for (const [index, recipient] of recipients.entries()) {
    let step;
    try {
      step = computeCurveBuy({
        quoteIn: recipient.amountIn,
        pricingQuoteReserve: quoteReserve,
        tokenReserve,
        feeBps: args.feeBps,
        creatorTaxBps: args.creatorTaxBps,
        // Zero because every recipient is verified exempt above. That is the whole
        // point of the feature, and it is why the exemption check is not optional.
        snipeTaxBps: 0n,
        reservedTokens: args.reservedTokens,
      });
    } catch (error) {
      if (error instanceof SnipeTaxNotModellableError) {
        return {
          ok: false,
          code: "NOT_MODELLABLE",
          message:
            "This launch's fees cannot be modelled locally, so bundle amounts cannot be " +
            "planned honestly. Reduce the creator tax or bundle after the window closes.",
        };
      }
      return {
        ok: false,
        code: "EXCEEDS_CURVE_ALLOCATION",
        message:
          `The bundle exhausts the curve's sellable allocation at wallet ${index + 1} ` +
          `(${recipient.address}). Lower the amounts or use fewer wallets.`,
      };
    }

    if (step.partialFill) {
      warnings.push(
        `Wallet ${index + 1} (${recipient.address}) would only be filled in part — the ` +
          `bundle reaches the curve's graduation point. The unspent remainder is refunded.`,
      );
    }

    buys.push({
      recipient: recipient.address,
      amountIn: recipient.amountIn,
      expectedOut: step.tokensOut,
      // Replaced below, once the worst case is known.
      minOut: 0n,
      order: index,
    });

    totalIn += recipient.amountIn;
    totalExpectedOut += step.tokensOut;

    // Advance the reserves the way the contract will.
    const netIn =
      step.spent - step.feeAmount - step.creatorTaxAmount - step.snipeTaxAmount;
    quoteReserve += netIn;
    tokenReserve -= step.tokensOut;
  }

  // ── Enforced floors: price each buy as if it landed LAST.
  //
  // Not paranoia. A bundle is not atomic. If a floor were priced on the reserve at
  // planning time, the first buy would move the price and every later buy would revert
  // on its own slippage check — the bundle would half-execute and look like a bug.
  const floors = worstCaseFloors(args, recipients);
  if (!floors.ok) return floors.error;

  const withFloors = buys.map((buy, index) => ({
    ...buy,
    minOut: applySlippageFloor(floors.value[index] ?? 0n, slippageBps),
  }));

  if (recipients.length > 8) {
    warnings.push(
      `${recipients.length} sequential transactions will not all confirm inside the ` +
        `anti-snipe window, which is only a few seconds long. Wallets later in the list may ` +
        `land after it closes. They still pay no tax — they are exempt — but they will buy ` +
        `at a price other traders have already moved.`,
    );
  }

  return {
    ok: true,
    plan: { buys: withFloors, totalIn, totalExpectedOut, warnings },
  };
}

/**
 * For each recipient, the tokens it would receive if every OTHER buy in the bundle
 * executed before it. Order-independent by construction, so any interleaving still
 * satisfies every floor.
 */
function worstCaseFloors(
  args: PlanBundleArgs,
  recipients: readonly BundleRecipient[],
):
  | { readonly ok: true; readonly value: readonly bigint[] }
  | { readonly ok: false; readonly error: Extract<PlanBundleResult, { ok: false }> } {
  const floors: bigint[] = [];

  for (const target of recipients) {
    let quoteReserve = args.pricingQuoteReserve;
    let tokenReserve = args.tokenReserve;

    // Everyone else first.
    for (const other of recipients) {
      if (other.address.toLowerCase() === target.address.toLowerCase()) continue;
      try {
        const step = computeCurveBuy({
          quoteIn: other.amountIn,
          pricingQuoteReserve: quoteReserve,
          tokenReserve,
          feeBps: args.feeBps,
          creatorTaxBps: args.creatorTaxBps,
          snipeTaxBps: 0n,
          reservedTokens: args.reservedTokens,
        });
        quoteReserve +=
          step.spent - step.feeAmount - step.creatorTaxAmount - step.snipeTaxAmount;
        tokenReserve -= step.tokensOut;
      } catch {
        // The curve runs dry in this permutation. A floor of zero would silently
        // disable the protection, so the bundle is refused instead.
        return {
          ok: false,
          error: {
            ok: false,
            code: "EXCEEDS_CURVE_ALLOCATION",
            message:
              "In the worst ordering this bundle exhausts the curve, so a safe minimum " +
              "cannot be set for every wallet. Lower the amounts or use fewer wallets.",
          },
        };
      }
    }

    // Then the target, against the moved price.
    try {
      const step = computeCurveBuy({
        quoteIn: target.amountIn,
        pricingQuoteReserve: quoteReserve,
        tokenReserve,
        feeBps: args.feeBps,
        creatorTaxBps: args.creatorTaxBps,
        snipeTaxBps: 0n,
        reservedTokens: args.reservedTokens,
      });
      floors.push(step.tokensOut);
    } catch {
      return {
        ok: false,
        error: {
          ok: false,
          code: "EXCEEDS_CURVE_ALLOCATION",
          message:
            `${target.address} cannot be filled if every other wallet buys first. Lower the ` +
            `amounts or use fewer wallets.`,
        },
      };
    }
  }

  return { ok: true, value: floors };
}

/**
 * An executable bundle.
 *
 * Only constructible from a launch receipt. That is the type-level enforcement of R17:
 * a buy sent to an address with no code does not revert, it succeeds as a value transfer
 * and the ETH is unrecoverable. There is deliberately no way to build one of these from
 * a predicted or user-supplied curve address.
 */
export interface ExecutableBundle {
  readonly curve: Address;
  readonly native: boolean;
  readonly transactions: readonly BundleTransaction[];
}

export interface BundleTransaction {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly recipient: Address;
  readonly order: number;
}

export interface ConfirmedLaunch {
  /** Read from the launch receipt's `TokenLaunched` log, never predicted. */
  readonly curve: Address;
  readonly pairToken: Address;
  /** Present so a caller cannot fabricate this object from nothing. */
  readonly launchTxHash: Hex;
  /** Confirmed to hold code. A buy to a codeless address strands the ETH. */
  readonly curveHasCode: boolean;
}

/**
 * Extract the launched curve from a mined receipt.
 *
 * This is the ONLY sanctioned way to obtain a `ConfirmedLaunch`, and that is deliberate.
 * The curve address is deterministic and could be predicted before launching, but a buy
 * sent to a predicted address that does not exist yet does not revert — it succeeds as a
 * value transfer to a codeless account and the ETH cannot be recovered (risk R17).
 *
 * Requiring a receipt means the failure mode is unreachable rather than merely
 * documented. The `curveHasCode` check is performed by the caller against the chain,
 * because a receipt proves the transaction mined, not that it mined on the canonical
 * chain after a reorg.
 */
export function confirmedLaunchFromReceipt(args: {
  readonly logs: readonly {
    address: Address;
    topics: readonly Hex[];
    data: Hex;
  }[];
  readonly transactionHash: Hex;
  readonly factory: Address;
  readonly curveHasCode: boolean;
}): ConfirmedLaunch | null {
  for (const log of args.logs) {
    // Only the configured factory is trusted. Any contract can emit a log with the same
    // signature, and believing one would point the bundle at an attacker's address.
    if (log.address.toLowerCase() !== args.factory.toLowerCase()) continue;

    const decoded = decodePonsLog({
      address: log.address,
      topics: log.topics as [] | [Hex, ...Hex[]],
      data: log.data,
      blockNumber: 0n,
      transactionHash: args.transactionHash,
      logIndex: 0,
      blockHash: null,
      removed: false,
      transactionIndex: 0,
    } as never);

    if (!decoded || decoded.name !== "TokenLaunched") continue;

    const curve = decoded.args.curve as Address | undefined;
    const pairToken = decoded.args.pairToken as Address | undefined;
    if (!curve || !pairToken) continue;

    return {
      curve,
      pairToken,
      launchTxHash: args.transactionHash,
      curveHasCode: args.curveHasCode,
    };
  }
  return null;
}

export function buildBundleTransactions(
  plan: BundlePlan,
  launch: ConfirmedLaunch,
): ExecutableBundle {
  if (!launch.curveHasCode) {
    // Refusing here rather than returning something the caller might send anyway. This
    // is the last gate in front of an unrecoverable loss.
    throw new Error(
      "Refusing to build bundle transactions: the curve address has no code yet. " +
        "A buy sent to a codeless address does not revert — the funds would be lost.",
    );
  }

  const native = /^0x0{40}$/i.test(launch.pairToken);

  return {
    curve: launch.curve,
    native,
    transactions: plan.buys.map((buy) => ({
      to: launch.curve,
      data: encodeFunctionData({
        abi: ponsV2CurveAbi,
        functionName: "buy",
        args: [buy.amountIn, buy.minOut, buy.recipient],
      }),
      // Native launches require msg.value === amountIn exactly. ERC-20 launches must
      // send zero value and rely on an allowance granted to the curve.
      value: native ? buy.amountIn : 0n,
      recipient: buy.recipient,
      order: buy.order,
    })),
  };
}

/**
 * Gas ceiling for bundle transactions.
 *
 * A launch burns roughly 3.7M gas and everything competing for the same window is
 * bidding. Being underpriced here does not cost money, it costs the entire feature: a
 * bundle buy that confirms after the window is just a normal buy at a worse price.
 *
 * The multiplier is intentionally generous. `baseFee` can only rise 12.5% per block, and
 * with 0.1 s blocks that compounds fast over a few seconds.
 */
export function bundleGasCeiling(baseFeePerGas: bigint, priorityFeePerGas: bigint) {
  return {
    maxFeePerGas: baseFeePerGas * 6n + priorityFeePerGas,
    maxPriorityFeePerGas: priorityFeePerGas,
  };
}

/** Total the payer must hold: every buy plus a gas allowance. */
export function bundleFundingRequirement(args: {
  plan: BundlePlan;
  native: boolean;
  gasPerBuy: bigint;
  maxFeePerGas: bigint;
}): { readonly quoteAsset: bigint; readonly nativeForGas: bigint } {
  const gas = BigInt(args.plan.buys.length) * args.gasPerBuy * args.maxFeePerGas;
  return {
    quoteAsset: args.plan.totalIn,
    // For a native launch the buys and the gas both come out of the same balance.
    nativeForGas: args.native ? gas + args.plan.totalIn : gas,
  };
}
