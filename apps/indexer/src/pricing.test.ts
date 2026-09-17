import { describe, expect, it } from "vitest";
import {
  PRICE_SCALE,
  competitionExclusion,
  marketCapFromPrice,
  priceFromReserves,
  priceFromTrade,
  volumeFromTrade,
} from "./pricing.js";

/**
 * Pricing is where a float would do the most damage: price feeds market cap, which
 * feeds Explore sorting and the trending engine. These tests use real magnitudes from
 * the Phase 0 audit so the assertions mean something.
 */

const SUPPLY = 1_000_000_000_000_000_000_000_000_000n; // 1e27, live config 0
const PHANTOM = 1_680_000_000_000_000_000n; // 1.68 ETH
const ONE_ETH = 1_000_000_000_000_000_000n;

/**
 * The quote asset's decimals, not the token's, are what break integer pricing.
 *
 * Measured against the indexed database on 2026-09-17: every one of the 124 tokens
 * quoted in the 8-decimal asset had price 0, including SATOSHI after 395 settled
 * trades. 1e18 was a scale chosen for an 18-decimal quote and applied to all of them.
 */
describe("price scale against low-decimal quote assets", () => {
  it("prices SATOSHI's real trade, which the old scale floored to zero", () => {
    // The most recent SATOSHI sell: 2,823 quote base units (8 decimals) for
    // 540,440,857,263,784,622,848,790 token base units.
    const quoteAmount = 2_823n;
    const tokenAmount = 540_440_857_263_784_622_848_790n;

    expect(priceFromTrade({ quoteAmount, tokenAmount })).toBeGreaterThan(0n);
    // What the old scale produced, and why the UI showed "0" for a token that had
    // traded 395 times.
    expect((quoteAmount * 10n ** 18n) / tokenAmount).toBe(0n);
  });

  it("keeps a full order of magnitude of headroom below that", () => {
    // Ten times smaller again still resolves, so this is not a fix that only just
    // clears the one observed vector.
    expect(
      priceFromTrade({
        quoteAmount: 282n,
        tokenAmount: 540_440_857_263_784_622_848_790n,
      }),
    ).toBeGreaterThan(0n);
  });

  it("leaves market cap in quote base units, so display call sites are unaffected", () => {
    // The scale is divided back out, so the same real price yields the same cap
    // whichever scale it was stored at. This is what made the change safe for the UI:
    // marketCap and volume keep their units, only `price` gains resolution.
    const supply = 10n ** 27n;
    const realPrice = 1_680_000_000n; // as stored under the old 1e18 scale
    const legacyCap = (realPrice * supply) / 10n ** 18n;
    const currentCap = marketCapFromPrice(realPrice * 10n ** 9n, supply);
    expect(currentCap).toBe(legacyCap);
  });

  it("still prices an 18-decimal quote the same way, in real terms", () => {
    // 1 ETH bought 366,037,735,849,056,603,773,584,905 tokens — the verified vector.
    const price = priceFromTrade({
      quoteAmount: 10n ** 18n,
      tokenAmount: 366_037_735_849_056_603_773_584_905n,
    });
    // Same real price as the old 2_731_958_762n at 1e18, now carrying nine more
    // digits of resolution rather than a different value.
    expect(price / 10n ** 9n).toBe(2_731_958_762n);
  });
});

describe("priceFromTrade", () => {
  it("prices the verified 1 ETH buy vector", () => {
    // 1 ETH bought 366,037,735,849,056,603,773,584,905 tokens on the reference curve.
    const price = priceFromTrade({
      quoteAmount: ONE_ETH,
      tokenAmount: 366_037_735_849_056_603_773_584_905n,
    });
    // ~2.73e-9 ETH per token, at the 1e27 scale. The old 1e18 scale rendered this as
    // 2_731_958_762 — the same real price, nine digits of resolution shorter.
    expect(price).toBe(2_731_958_762_886_597_938n);
  });

  it("keeps a memecoin price expressible instead of truncating it to zero", () => {
    // Without the scale, quote/token here would floor to 0 and every downstream
    // market cap would be zero.
    const price = priceFromTrade({
      quoteAmount: 10_000_000_000_000_000n, // 0.01 ETH
      tokenAmount: 5_740_664_023_199_384_506_125_347n,
    });
    expect(price).toBeGreaterThan(0n);
    expect(price).toBe(1_741_958_762_886_597_938n);
  });

  it("is monotonic: paying more for fewer tokens is a higher price", () => {
    const cheap = priceFromTrade({ quoteAmount: ONE_ETH, tokenAmount: 1_000_000n });
    const expensive = priceFromTrade({ quoteAmount: ONE_ETH, tokenAmount: 500_000n });
    expect(expensive).toBeGreaterThan(cheap);
  });

  it("returns zero rather than throwing on a degenerate settled trade", () => {
    // A clamped buy near graduation can settle with almost nothing. The indexer must
    // not crash on a real on-chain event.
    expect(priceFromTrade({ quoteAmount: ONE_ETH, tokenAmount: 0n })).toBe(0n);
    expect(priceFromTrade({ quoteAmount: 0n, tokenAmount: 1n })).toBe(0n);
  });

  it("uses a fixed scale that must not drift", () => {
    // Changing this changes the meaning of every stored price row. It moved from 1e18
    // to 1e27 once, on 2026-09-17, because 1e18 floored every price quoted in the
    // 8-decimal asset to zero. A further change needs the same recompute.
    expect(PRICE_SCALE).toBe(10n ** 27n);
  });
});

describe("priceFromReserves", () => {
  it("reports a non-zero opening price for an untraded launch", () => {
    // The curve opens with a virtual 1.68 ETH against the full supply. Using the
    // real reserve here would report zero for every token that has not traded.
    const price = priceFromReserves({
      pricingQuoteReserve: PHANTOM,
      tokenReserve: SUPPLY,
    });
    expect(price).toBe(1_680_000_000_000_000_000n);
  });

  it("rises as the token reserve is bought down", () => {
    const atLaunch = priceFromReserves({
      pricingQuoteReserve: PHANTOM,
      tokenReserve: SUPPLY,
    });
    const later = priceFromReserves({
      pricingQuoteReserve: PHANTOM + ONE_ETH,
      tokenReserve: SUPPLY / 2n,
    });
    expect(later).toBeGreaterThan(atLaunch);
  });

  it("returns zero for an empty token reserve", () => {
    expect(priceFromReserves({ pricingQuoteReserve: PHANTOM, tokenReserve: 0n })).toBe(
      0n,
    );
  });
});

describe("marketCapFromPrice", () => {
  it("divides the price scale back out, giving quote base units", () => {
    // Opening price at 1e27 scale, times 1e27 supply, equals the 1.68 ETH the curve
    // virtually opens against. The cap is INVARIANT under the scale change: the scale
    // is divided back out, which is why no display call site had to move.
    const cap = marketCapFromPrice(1_680_000_000_000_000_000n, SUPPLY);
    expect(cap).toBe(PHANTOM);
  });

  it("matches the verified trade price at full supply", () => {
    const price = priceFromTrade({
      quoteAmount: ONE_ETH,
      tokenAmount: 366_037_735_849_056_603_773_584_905n,
    });
    const cap = marketCapFromPrice(price, SUPPLY);
    // ~2.73 ETH implied cap after a 1 ETH buy. Carries the digits the old scale
    // truncated: it used to read 2_731_958_762_000_000_000.
    expect(cap).toBe(2_731_958_762_886_597_938n);
  });

  it("does not overflow at uint256-scale inputs", () => {
    const cap = marketCapFromPrice(10n ** 30n, 10n ** 30n);
    expect(cap).toBe(10n ** 33n);
  });

  it("returns zero for degenerate inputs", () => {
    expect(marketCapFromPrice(0n, SUPPLY)).toBe(0n);
    expect(marketCapFromPrice(1n, 0n)).toBe(0n);
  });
});

describe("volumeFromTrade", () => {
  it("always measures the quote leg, so buys and sells are comparable", () => {
    expect(volumeFromTrade({ quoteAmount: ONE_ETH, tokenAmount: 123n })).toBe(ONE_ETH);
    expect(volumeFromTrade({ quoteAmount: ONE_ETH, tokenAmount: 999n })).toBe(ONE_ETH);
  });

  it("is zero for a trade that moved no quote asset", () => {
    expect(volumeFromTrade({ quoteAmount: 0n, tokenAmount: 100n })).toBe(0n);
  });
});

describe("competitionExclusion", () => {
  const trader = "0x1111111111111111111111111111111111111111";
  const recipient = "0x2222222222222222222222222222222222222222";

  it("counts an ordinary trade", () => {
    const verdict = competitionExclusion({
      traderAddress: trader,
      recipientAddress: recipient,
      quoteAmount: ONE_ETH,
      minTradeSize: 0n,
      excludedAddresses: [],
    });
    expect(verdict.excluded).toBe(false);
  });

  it("excludes dust below the minimum trade size", () => {
    const verdict = competitionExclusion({
      traderAddress: trader,
      recipientAddress: recipient,
      quoteAmount: 1n,
      minTradeSize: ONE_ETH,
      excludedAddresses: [],
    });
    expect(verdict).toEqual({ excluded: true, reason: "BELOW_MIN_TRADE_SIZE" });
  });

  it("excludes an admin-listed address regardless of casing", () => {
    const verdict = competitionExclusion({
      traderAddress: trader.toUpperCase().replace("0X", "0x"),
      recipientAddress: recipient,
      quoteAmount: ONE_ETH,
      minTradeSize: 0n,
      excludedAddresses: [trader],
    });
    expect(verdict).toEqual({ excluded: true, reason: "ADDRESS_EXCLUDED" });
  });

  it("excludes a whitelist bundle recipient, so a launch cannot farm its own board", () => {
    // A bundle recipient never competed for its fill — it was handed one at the
    // untaxed price.
    const verdict = competitionExclusion({
      traderAddress: trader,
      recipientAddress: recipient,
      quoteAmount: ONE_ETH,
      minTradeSize: 0n,
      excludedAddresses: [],
      bundleWallets: [recipient],
    });
    expect(verdict).toEqual({ excluded: true, reason: "BUNDLE_RECIPIENT" });
  });

  it("always gives a reason when it excludes, so a gap is never unexplained", () => {
    const cases = [
      { quoteAmount: 1n, minTradeSize: ONE_ETH, excludedAddresses: [] as string[] },
      { quoteAmount: ONE_ETH, minTradeSize: 0n, excludedAddresses: [trader] },
    ];
    for (const testCase of cases) {
      const verdict = competitionExclusion({
        traderAddress: trader,
        recipientAddress: recipient,
        ...testCase,
      });
      expect(verdict.excluded).toBe(true);
      expect(verdict.reason).toBeTruthy();
    }
  });
});
