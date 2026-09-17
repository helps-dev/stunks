import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OfficialTokenSpotlight } from "./official-token";
import type { OfficialToken } from "@/lib/official-token";

/**
 * Renders the real panel to HTML.
 *
 * The rules worth protecting here are about ABSENCE — a tile that must not appear when
 * the number behind it does not exist. Absence is invisible in a screenshot and
 * survives review easily, so it is asserted instead.
 *
 * The figures come from a token shaped like an indexed row. Nothing is mocked beyond
 * that: the component, its formatting and its conditionals are the ones that ship.
 */

/**
 * Fixture addresses, built rather than written out.
 *
 * Two reasons. The repo forbids address literals outside @stunks/config, and rightly:
 * every address in this codebase is resolved on-chain from the configured factory. And
 * a realistic-looking address in a fixture can be mistaken for a real one by whoever
 * reads the test next — a repeating byte cannot.
 */
const fakeAddress = (byte: string): string => `0x${byte.repeat(20)}`;

const BASE = {
  id: "tok_1",
  address: fakeAddress("a7"),
  name: "Stunks Official",
  symbol: "STUNKS",
  decimals: 18,
  imageUrl: "ipfs://bafkreiabc",
  creatorAddress: fakeAddress("11"),
  pairTokenAddress: fakeAddress("00"),
  pairTokenDecimals: 18,
  phase: "NOT_GRADUATED",
  price: 1_000_000_000n,
  marketCap: 12_340_000_000_000_000_000n,
  volume24h: 5_600_000_000_000_000_000n,
  volumeTotal: 9_000_000_000_000_000_000n,
  graduationBps: 4_250,
  holderCount: 0,
  tradeCount: 1_904,
  creatorTaxBps: 100,
  totalSupply: 1_000_000_000_000_000_000_000_000_000n,
  hadWhitelistBundle: false,
  whitelistSize: 0,
  moderationStatus: "VISIBLE",
  launchBlock: 65_000_000n,
  createdAt: new Date("2026-09-17T00:00:00Z"),
  lastTradeAt: new Date("2026-09-18T00:00:00Z"),
  description: "The official coin of STUNKS.FUN.",
  websiteUrl: "https://stunks.fun",
  twitterUrl: "https://x.com/stunksfun",
  telegramUrl: null,
  discordUrl: null,
  farcasterUrl: null,
  buybackEnabled: true,
  changeBps: 1_440,
  changeWindowHours: 24,
} as unknown as OfficialToken;

function render(overrides: Partial<OfficialToken> = {}): string {
  const token = { ...BASE, ...overrides } as OfficialToken;
  return renderToStaticMarkup(<OfficialTokenSpotlight token={token} />);
}

describe("official token spotlight", () => {
  it("shows the symbol, name and description", () => {
    const html = render();
    expect(html).toContain("$STUNKS");
    expect(html).toContain("Stunks Official");
    expect(html).toContain("The official coin of STUNKS.FUN.");
    expect(html).toContain("OFFICIAL COIN OF STUNKS.FUN");
  });

  it("shows the contract address in full, never shortened", () => {
    // This is the string people paste into a wallet before spending money. A
    // truncated address cannot be checked against another source.
    expect(render()).toContain(BASE.address);
  });

  it("hides the holders tile while nothing populates it", () => {
    // `holderCount` is 0 on every indexed token and the holders table is empty, so a
    // tile here would read "0 holders" under the site's own coin (R49).
    expect(render({ holderCount: 0 })).not.toContain("Holders");
  });

  it("shows the holders tile once there is a count", () => {
    const html = render({ holderCount: 412 });
    expect(html).toContain("Holders");
    expect(html).toContain("412");
  });

  it("omits the change tile when there is no comparable price", () => {
    const html = render({ changeBps: null, changeWindowHours: null });
    expect(html).not.toContain("change");
  });

  it("labels the change with the window actually measured", () => {
    expect(render({ changeBps: -2_860, changeWindowHours: 14 })).toContain(
      "14H change",
    );
    expect(render({ changeBps: -2_860, changeWindowHours: 14 })).toContain("-28.6%");
  });

  it("shows graduation progress only while the token is on its curve", () => {
    expect(render({ phase: "NOT_GRADUATED" })).toContain("To graduation");
    expect(render({ phase: "POOL_CREATED" })).not.toContain("To graduation");
  });

  it("marks creator links nofollow and opener-safe", () => {
    const html = render();
    expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
    expect(html).toContain("https://x.com/stunksfun");
    // A social the creator left blank is not rendered as an empty button.
    expect(html).not.toContain(">Telegram");
  });

  it("proxies the image rather than hotlinking it", () => {
    // Keeps `img-src 'self'` intact and keeps visitor IPs away from creator hosts.
    const html = render();
    expect(html).toContain("/api/token-image?url=");
    expect(html).not.toContain('src="ipfs://');
  });

  it("keeps the letter mark under the image as the fallback", () => {
    // No JavaScript is involved: a dead host reveals the mark beneath.
    expect(render()).toContain(">ST<");
  });

  it("claims no verification anywhere", () => {
    // A promoted placement must not read as an audit.
    const html = render().toLowerCase();
    for (const word of ["verified", "audited", "safe", "endorsed"]) {
      expect(html).not.toContain(word);
    }
  });
});
