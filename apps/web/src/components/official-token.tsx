import {
  formatBps,
  formatCompact,
  formatPrice,
  formatProgress,
} from "@stunks/utils";
import { robinhoodChain } from "@stunks/config";
import { CopyAddress } from "@/components/copy-address";
import { TokenAvatar } from "@/components/token-avatar";
import { describeChange } from "@/lib/official-token";
import type { OfficialToken } from "@/lib/official-token";

/**
 * The project's own token, given the top of the page.
 *
 * EVERY FIGURE HERE IS THE SAME FIGURE THE TOKEN'S OWN CARD SHOWS. The spotlight is a
 * placement, not a second source: it reads the indexed row like every other surface,
 * and a number that is not in the index is not shown at all rather than estimated for
 * the sake of filling a tile. A promotional panel on the operator's own token is
 * exactly where a made-up number would do the most damage.
 *
 * THE TILES ARE CHOSEN BY WHAT EXISTS, NOT BY WHAT LOOKS FULL. The 24-hour change is
 * dropped when there is no comparable price behind it, and graduation progress only
 * appears for a token still on its curve. The grid reflows; it does not show a dash
 * where a number should be.
 *
 * `rel="nofollow ugc"` is on the creator's links for the same reason it is on every
 * other token's: these came from launch calldata. That this is the operator's own
 * token does not make the link a different kind of link, and giving it different
 * treatment is how a launchpad ends up with a verified-looking badge it never earned.
 */

const EXPLORER = robinhoodChain.blockExplorers?.default.url ?? null;

function Tile({
  label,
  value,
  tone = "",
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: string;
}) {
  return (
    <div className="spotlight-tile">
      <span className="spotlight-tile-label">{label}</span>
      <strong className={`spotlight-tile-value mono ${tone}`.trim()}>{value}</strong>
    </div>
  );
}

function withDollar(symbol: string): string {
  return symbol.startsWith("$") ? symbol : `$${symbol}`;
}

const PHASE_LABEL: Record<string, string> = {
  NOT_GRADUATED: "On curve",
  SWEPT: "Pool pending",
  POOL_CREATED: "Graduated",
  RESCUED: "Rescued",
};

export function OfficialTokenSpotlight({ token }: { readonly token: OfficialToken }) {
  const quoteDecimals = token.pairTokenDecimals;
  const isNative = /^0x0{40}$/i.test(token.pairTokenAddress);
  const quoteSymbol = isNative ? "ETH" : "quote";
  const onCurve = token.phase === "NOT_GRADUATED";

  const links: { label: string; url: string | null }[] = [
    { label: "Website", url: token.websiteUrl },
    { label: "X", url: token.twitterUrl },
    { label: "Telegram", url: token.telegramUrl },
    { label: "Discord", url: token.discordUrl },
    { label: "Farcaster", url: token.farcasterUrl },
  ];
  const usableLinks = links.filter(
    (link): link is { label: string; url: string } =>
      link.url !== null && link.url.startsWith("https://"),
  );

  const change = describeChange(token);
  const description = token.description?.trim() ?? "";

  return (
    <section className="spotlight" data-reveal>
      <div className="spotlight-inner">
        <div className="spotlight-head">
          <p className="spotlight-kicker">{"{ OFFICIAL COIN OF STUNKS.FUN }"}</p>
          <div className="spotlight-flags">
            <span className="badge">{PHASE_LABEL[token.phase] ?? token.phase}</span>
            <span className="badge">{formatBps(token.creatorTaxBps)} creator tax</span>
            {token.buybackEnabled && <span className="badge">Buyback enabled</span>}
            <span className="badge brand">{withDollar(token.symbol)}</span>
          </div>
        </div>

        <div className="spotlight-body">
          <TokenAvatar
            symbol={token.symbol}
            imageUrl={token.imageUrl}
            className="spotlight-avatar"
          />

          <div className="spotlight-detail">
            <h2 className="spotlight-title">
              <span className="spotlight-symbol">{withDollar(token.symbol)}</span>
              <span className="spotlight-name">{token.name}</span>
            </h2>

            {description !== "" && <p className="spotlight-copy">{description}</p>}

            <CopyAddress address={token.address} />

            <div className="spotlight-tiles">
              <Tile
                label="Price"
                value={`${formatPrice(token.price, quoteDecimals, 4, token.decimals)} ${quoteSymbol}`}
              />
              <Tile
                label="Market cap"
                value={`${formatCompact(token.marketCap, quoteDecimals)} ${quoteSymbol}`}
              />
              {change !== null && (
                <Tile label={change.label} value={change.value} tone={change.tone} />
              )}
              <Tile
                label="Volume 24h"
                value={`${formatCompact(token.volume24h, quoteDecimals)} ${quoteSymbol}`}
              />
              {/*
                Only when there is a count to show. Nothing populates `holderCount` —
                it is read from the token row and written straight back, and the
                `holders` table is empty on all 28,701 indexed tokens — so this tile
                would otherwise read "0 holders" under the site's own coin, on the most
                prominent panel it has. Rendering it conditionally means it appears by
                itself the day holder indexing lands, with no change here.
              */}
              {token.holderCount > 0 && (
                <Tile label="Holders" value={token.holderCount.toLocaleString("en-US")} />
              )}
              <Tile label="Trades" value={token.tradeCount.toLocaleString("en-US")} />
              {onCurve && (
                <Tile
                  label="To graduation"
                  value={formatProgress(token.graduationBps)}
                />
              )}
            </div>

            <div className="spotlight-actions">
              <a className="btn btn-primary" href={`/token/${token.address}`}>
                Trade {withDollar(token.symbol)}
              </a>
              {usableLinks.map((link) => (
                <a
                  key={link.label}
                  className="btn btn-quiet"
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow ugc"
                >
                  {link.label} ↗
                </a>
              ))}
              {EXPLORER !== null && (
                <a
                  className="spotlight-explorer"
                  href={`${EXPLORER}/address/${token.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on explorer ↗
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
