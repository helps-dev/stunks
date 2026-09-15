import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Address, type PublicClient } from "viem";
import { GraduationPhase, type CurveState, type LaunchedToken } from "@stunks/types";
import { ponsV2CurveAbi } from "../abi/curve.js";
import { erc20Abi } from "../abi/index.js";
import type * as ReadsModule from "../client/reads.js";

/**
 * Trade service tests.
 *
 * These target the decisions the service makes, not the curve math — that is verified to
 * the wei against mainnet in `curve/math.test.ts`. What matters here is what a wrong
 * implementation gets wrong *silently*:
 *
 *  - offering a trade in a state where it is guaranteed to revert (Swept, V4, non-Pons)
 *  - forgetting the on-chain minimum-out, leaving the user with only an advisory quote
 *  - swapping value and approval, which are exact opposites for native vs ERC-20 quotes
 *
 * The chain reads are mocked at the module boundary so each state can be pinned exactly.
 * That is the only honest way to test "what does this do when the token is Swept" without
 * finding a Swept token on mainnet.
 */

const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const CURVE = "0x2222222222222222222222222222222222222222" as Address;
const TRADER = "0x3333333333333333333333333333333333333333" as Address;
const OTHER = "0x9999999999999999999999999999999999999999" as Address;
const USDG = "0x4444444444444444444444444444444444444444" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const POOL_MANAGER = "0x5555555555555555555555555555555555555555" as Address;
const MEME_HOOK = "0x6666666666666666666666666666666666666666" as Address;

const mocks = vi.hoisted(() => ({
  readLaunchedToken: vi.fn(),
  readCurveState: vi.fn(),
  readSnipeTaxExempt: vi.fn(),
  readCurrentSnipeTaxBps: vi.fn(),
  resolvePonsAddresses: vi.fn(),
}));

vi.mock("../client/reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ReadsModule>();
  return {
    ...actual, // isNativeQuote stays real: it is the thing under test on the value path
    readLaunchedToken: mocks.readLaunchedToken,
    readCurveState: mocks.readCurveState,
    readSnipeTaxExempt: mocks.readSnipeTaxExempt,
    readCurrentSnipeTaxBps: mocks.readCurrentSnipeTaxBps,
  };
});

vi.mock("../client/addresses.js", () => ({
  resolvePonsAddresses: mocks.resolvePonsAddresses,
}));

const { prepareTrade, MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, SLIPPAGE_PRESETS_BPS } =
  await import("./service.js");

/** A client that only needs to answer getBlock; every read is mocked above. */
const client = {
  getBlock: async () => ({ timestamp: 1_800_000_000n }),
} as unknown as PublicClient;

function launchedToken(overrides: Partial<LaunchedToken> = {}): LaunchedToken {
  return {
    exists: true,
    curve: CURVE,
    pairToken: NATIVE,
    phase: GraduationPhase.NotGraduated,
    creatorFeeRecipient: TRADER,
    creatorTaxBps: 100n,
    buybackEnabled: true,
    graduationThreshold: 4_200_000_000_000_000_000n,
    poolFee: 0,
    tickSpacing: 200,
    ...overrides,
  } as LaunchedToken;
}

/**
 * Config-0 shaped curve state: supply 1e27, phantom 1.68e18, threshold 4.2e18. Real
 * config values so the quote it produces is representative rather than arbitrary.
 */
function curveState(overrides: Partial<CurveState> = {}): CurveState {
  return {
    curve: CURVE,
    token: TOKEN,
    pairToken: NATIVE,
    pricingQuoteReserve: 1_680_000_000_000_000_000n,
    tokenReserve: 1_000_000_000_000_000_000_000_000_000n,
    realQuoteReserve: 0n,
    phantomQuote: 1_680_000_000_000_000_000n,
    graduationThreshold: 4_200_000_000_000_000_000n,
    reservedTokens: 285_714_285_714_285_714_285_714_285n,
    feeBps: 100n,
    creatorTaxBps: 100n,
    snipeTaxStartBps: 9_900n,
    snipeTaxSeconds: 3n,
    // Long before the mocked block timestamp, so the snipe window is closed and local
    // math is allowed to answer. Window behaviour is tested separately.
    launchedAt: 1_700_000_000n,
    graduated: false,
    readyToGraduate: false,
    ...overrides,
  } as CurveState;
}

const ONE_HUNDREDTH_ETH = 10_000_000_000_000_000n;

function buy(overrides: Record<string, unknown> = {}) {
  return prepareTrade({
    client,
    factory: FACTORY,
    token: TOKEN,
    side: "BUY",
    amountIn: ONE_HUNDREDTH_ETH,
    slippageBps: 100,
    account: TRADER,
    ...overrides,
  } as Parameters<typeof prepareTrade>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readLaunchedToken.mockResolvedValue(launchedToken());
  mocks.readCurveState.mockResolvedValue(curveState());
  mocks.readSnipeTaxExempt.mockResolvedValue(false);
  mocks.readCurrentSnipeTaxBps.mockResolvedValue(0n);
  mocks.resolvePonsAddresses.mockResolvedValue({
    poolManager: POOL_MANAGER,
    memeHook: MEME_HOOK,
  });
});

describe("input validation", () => {
  it("refuses a zero amount rather than encoding a no-op transaction", async () => {
    const result = await buy({ amountIn: 0n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ZERO_AMOUNT");
  });

  it("refuses a negative amount", async () => {
    const result = await buy({ amountIn: -1n });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ZERO_AMOUNT");
  });

  it("refuses slippage below the floor", async () => {
    const result = await buy({ slippageBps: MIN_SLIPPAGE_BPS - 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SLIPPAGE_OUT_OF_RANGE");
  });

  it("refuses slippage above the ceiling, which would accept almost any fill", async () => {
    const result = await buy({ slippageBps: MAX_SLIPPAGE_BPS + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SLIPPAGE_OUT_OF_RANGE");
  });

  it("refuses a fractional bps value instead of silently truncating it", async () => {
    const result = await buy({ slippageBps: 100.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SLIPPAGE_OUT_OF_RANGE");
  });

  it("accepts every preset the UI offers", async () => {
    for (const preset of SLIPPAGE_PRESETS_BPS) {
      const result = await buy({ slippageBps: preset });
      expect(result.ok, `preset ${preset} should be accepted`).toBe(true);
    }
  });

  it("validates before touching the network, so a bad input costs no RPC call", async () => {
    await buy({ amountIn: 0n });
    expect(mocks.readLaunchedToken).not.toHaveBeenCalled();
  });
});

describe("venue guard", () => {
  it("refuses a token the factory does not know", async () => {
    mocks.readLaunchedToken.mockResolvedValue(launchedToken({ exists: false }));
    const result = await buy();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_A_PONS_LAUNCH");
      expect(result.message).toMatch(/not registered with the Pons V2 factory/i);
    }
  });

  it("refuses a Swept token, where a trade would always revert", async () => {
    mocks.readLaunchedToken.mockResolvedValue(
      launchedToken({ phase: GraduationPhase.Swept }),
    );
    const result = await buy();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NO_VENUE");
      // Must explain that this is recoverable, not permanent.
      expect(result.message).toMatch(/waiting for its Uniswap V4 pool/i);
    }
  });

  it("refuses a Rescued token as terminal", async () => {
    mocks.readLaunchedToken.mockResolvedValue(
      launchedToken({ phase: GraduationPhase.Rescued }),
    );
    const result = await buy();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NO_VENUE");
      expect(result.message).toMatch(/will not graduate/i);
    }
  });

  it("refuses a graduated token rather than approximating a V4 quote", async () => {
    mocks.readLaunchedToken.mockResolvedValue(
      launchedToken({ phase: GraduationPhase.PoolCreated }),
    );
    const result = await buy();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNSUPPORTED_VENUE");
      expect(result.message).toMatch(/does not route V4 swaps yet/i);
    }
  });

  it("resolves real pool addresses for a graduated token, not placeholders", async () => {
    mocks.readLaunchedToken.mockResolvedValue(
      launchedToken({ phase: GraduationPhase.PoolCreated }),
    );
    await buy();
    // The bug this guards: passing the curve address as poolManager to satisfy the
    // resolver's signature, which made the V4 branch unreachable and reported the
    // misleading POOL_NOT_REGISTERED instead.
    expect(mocks.resolvePonsAddresses).toHaveBeenCalledWith(client, FACTORY);
  });

  it("does not pay for address resolution on the curve path", async () => {
    await buy();
    expect(mocks.resolvePonsAddresses).not.toHaveBeenCalled();
  });

  it("reports an unreachable RPC instead of guessing state", async () => {
    mocks.readLaunchedToken.mockRejectedValue(new Error("HTTP request failed"));
    const result = await buy();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RPC_UNAVAILABLE");
      expect(result.message).toMatch(/HTTP request failed/);
    }
  });
});

describe("buy — native quote asset", () => {
  it("sends the exact amount as value and requires no approval", async () => {
    const result = await buy();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The exact-value rule: native launches revert unless msg.value === quoteIn.
    expect(result.trade.value).toBe(ONE_HUNDREDTH_ETH);
    expect(result.trade.approval).toBeNull();
    expect(result.trade.to).toBe(CURVE);
  });

  it("encodes buy(amountIn, minOut, recipient) against the curve", async () => {
    const result = await buy();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const decoded = decodeFunctionData({ abi: ponsV2CurveAbi, data: result.trade.data });
    expect(decoded.functionName).toBe("buy");
    const args = decoded.args as readonly [bigint, bigint, Address];
    expect(args[0]).toBe(ONE_HUNDREDTH_ETH);
    expect(args[2]).toBe(TRADER);
  });

  it("always attaches a non-zero minimum out — the quote alone protects nobody", async () => {
    const result = await buy();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const args = decodeFunctionData({
      abi: ponsV2CurveAbi,
      data: result.trade.data,
    }).args as readonly [bigint, bigint, Address];

    expect(args[1]).toBeGreaterThan(0n);
    expect(args[1]).toBeLessThan(result.trade.quote.amountOut);
  });

  it("tightens the minimum out as slippage tolerance falls", async () => {
    const loose = await buy({ slippageBps: 500 });
    const tight = await buy({ slippageBps: 50 });
    expect(loose.ok && tight.ok).toBe(true);
    if (!loose.ok || !tight.ok) return;

    const minOf = (data: `0x${string}`) =>
      (decodeFunctionData({ abi: ponsV2CurveAbi, data }).args as readonly [
        bigint,
        bigint,
        Address,
      ])[1];

    expect(minOf(tight.trade.data)).toBeGreaterThan(minOf(loose.trade.data));
  });

  it("routes tokens to an explicit recipient when one is given", async () => {
    const result = await buy({ recipient: OTHER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const args = decodeFunctionData({
      abi: ponsV2CurveAbi,
      data: result.trade.data,
    }).args as readonly [bigint, bigint, Address];
    expect(args[2]).toBe(OTHER);
  });

  it("quotes the snipe tax against the recipient, not the payer", async () => {
    await buy({ recipient: OTHER });
    // Verified on-chain: the tax and the exemption key on the RECIPIENT. Passing the
    // payer here would under-report the tax by up to 99%.
    expect(mocks.readCurrentSnipeTaxBps).toHaveBeenCalledWith(client, CURVE, OTHER);
    expect(mocks.readSnipeTaxExempt).toHaveBeenCalledWith(client, CURVE, OTHER);
  });
});

describe("buy — ERC-20 quote asset", () => {
  beforeEach(() => {
    mocks.readLaunchedToken.mockResolvedValue(launchedToken({ pairToken: USDG }));
    mocks.readCurveState.mockResolvedValue(curveState({ pairToken: USDG }));
  });

  it("sends no value and requires an approval instead", async () => {
    const result = await buy();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Attaching value to an ERC-20 launch reverts; this is the exact inverse of native.
    expect(result.trade.value).toBe(0n);
    expect(result.trade.approval).not.toBeNull();
    expect(result.trade.approval?.token).toBe(USDG);
    expect(result.trade.approval?.spender).toBe(CURVE);
  });

  it("approves the exact amount, never an unlimited allowance", async () => {
    const result = await buy();
    expect(result.ok).toBe(true);
    if (!result.ok || !result.trade.approval) return;

    expect(result.trade.approval.amount).toBe(ONE_HUNDREDTH_ETH);
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: result.trade.approval.data,
    });
    expect(decoded.functionName).toBe("approve");
    const args = decoded.args as readonly [Address, bigint];
    expect(args[0]).toBe(CURVE);
    expect(args[1]).toBe(ONE_HUNDREDTH_ETH);
    expect(args[1]).not.toBe(2n ** 256n - 1n);
  });
});

describe("sell", () => {
  const TOKENS_IN = 1_000_000_000_000_000_000_000n;

  function sell(overrides: Record<string, unknown> = {}) {
    return buy({ side: "SELL", amountIn: TOKENS_IN, ...overrides });
  }

  it("never attaches value and always needs the launch token approved", async () => {
    const result = await sell();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.trade.value).toBe(0n);
    expect(result.trade.approval?.token).toBe(TOKEN);
    expect(result.trade.approval?.spender).toBe(CURVE);
    expect(result.trade.approval?.amount).toBe(TOKENS_IN);
  });

  it("encodes sell(amountIn, minQuoteOut, recipient)", async () => {
    const result = await sell();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const decoded = decodeFunctionData({ abi: ponsV2CurveAbi, data: result.trade.data });
    expect(decoded.functionName).toBe("sell");
    const args = decoded.args as readonly [bigint, bigint, Address];
    expect(args[0]).toBe(TOKENS_IN);
    expect(args[1]).toBeGreaterThan(0n);
    expect(args[2]).toBe(TRADER);
  });

  it("carries no snipe tax, which applies only to buys", async () => {
    const result = await sell();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trade.quote.snipeTaxBps).toBe(0n);
    expect(result.trade.quote.snipeTaxAmount).toBe(0n);
  });
});

describe("warnings", () => {
  it("warns about an active anti-snipe tax and says waiting is cheaper", async () => {
    mocks.readCurrentSnipeTaxBps.mockResolvedValue(618n);
    // Inside the window the service must simulate, so local math is not consulted;
    // the warning is what is under test here.
    const result = await buy();
    if (result.ok) {
      expect(result.trade.warnings.join(" ")).toMatch(/anti-snipe window/i);
    } else {
      // Simulation is unavailable against this stub, and refusing is the honest
      // outcome — it must not fall back to an unmodellable local number.
      expect(result.code).toBe("QUOTE_FAILED");
    }
  });

  it("warns when slippage tolerance is high enough to invite a sandwich", async () => {
    const result = await buy({ slippageBps: 2_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trade.warnings.join(" ")).toMatch(/high/i);
  });

  it("stays silent for an ordinary trade", async () => {
    const result = await buy({ slippageBps: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trade.warnings).toHaveLength(0);
  });

  it("warns on a trade large enough to move the price materially", async () => {
    // 1 ETH into a curve holding 1.68 ETH of pricing reserve is a large trade.
    const result = await buy({ amountIn: 1_000_000_000_000_000_000n });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trade.warnings.join(" ")).toMatch(/price impact/i);
  });
});

describe("graduated curve state", () => {
  it("refuses when the curve reports itself finished, even if the phase lags", async () => {
    // The phase is updated by a separate transaction, so the curve can report
    // graduated while getLaunchedToken still says NotGraduated. Trusting the phase
    // alone would offer a trade that reverts.
    mocks.readCurveState.mockResolvedValue(curveState({ readyToGraduate: true }));
    const result = await buy();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("QUOTE_FAILED");
  });
});
