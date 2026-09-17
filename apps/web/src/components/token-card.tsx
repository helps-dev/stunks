import {
  formatBps,
  formatCompact,
  formatProgress,
  formatRelativeTime,
  shortAddress,
} from "@stunks/utils";
import type { SerialisedToken } from "@/lib/queries";

/**
 * Token card.
 *
 * Shows only values that came from an indexed on-chain event or a live read. There are
 * no placeholder figures: a token with no trades shows a zero volume, not a plausible
 * invented one.
 *
 * The avatar is a deterministic symbol mark rather than loading an arbitrary metadata
 * image URL. Token image URLs are untrusted content; a visual fallback must never make
 * a card slower, break its layout, or imply that an image was verified by STUNKS.
 */

const PHASE_LABEL: Record<string, { text: string; tone: string }> = {
  NOT_GRADUATED: { text: "Curve", tone: "" },
  SWEPT: { text: "Pool pending", tone: "warn" },
  POOL_CREATED: { text: "Graduated", tone: "ok" },
  RESCUED: { text: "Rescued", tone: "warn" },
};

function displaySymbol(symbol: string): string {
  return symbol.startsWith("$") ? symbol : `$${symbol}`;
}

export function TokenCard({ token }: { token: SerialisedToken }) {
  const phase = PHASE_LABEL[token.phase] ?? { text: token.phase, tone: "" };
  const quoteDecimals = token.pairTokenDecimals;
  const isNative = /^0x0{40}$/i.test(token.pairTokenAddress);
  const quoteSymbol = isNative ? "ETH" : "quote";
  const avatar =
    token.symbol
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 2)
      .toUpperCase() || "?";

  return (
    <a
      href={`/token/${token.address}`}
      className="card"
      aria-label={`Open ${token.symbol}`}
    >
      <div className="card-head">
        <div className="card-title">
          <span className="token-avatar" aria-hidden="true">
            {avatar}
          </span>
          <span className="card-title-copy">
            <span className="card-symbol">{displaySymbol(token.symbol)}</span>
            <span className="card-name">{token.name}</span>
          </span>
        </div>
        <span className={`badge ${phase.tone}`}>{phase.text}</span>
      </div>

      <div className="card-grid">
        <div>
          <span className="card-label">Market cap</span>
          <span className="card-value mono">
            {formatCompact(BigInt(token.marketCap), quoteDecimals)} {quoteSymbol}
          </span>
        </div>
        <div>
          <span className="card-label">Volume 24h</span>
          <span className="card-value mono">
            {formatCompact(BigInt(token.volume24h), quoteDecimals)} {quoteSymbol}
          </span>
        </div>
        <div>
          <span className="card-label">Trades</span>
          <span className="card-value mono">
            {token.tradeCount.toLocaleString("en-US")}
          </span>
        </div>
        <div>
          <span className="card-label">Creator tax</span>
          <span className="card-value mono">{formatBps(token.creatorTaxBps)}</span>
        </div>
      </div>

      {token.phase === "NOT_GRADUATED" && (
        <div className="progress">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${Math.min(100, token.graduationBps / 100)}%` }}
            />
          </div>
          <span className="card-label">
            {formatProgress(token.graduationBps)} to graduation
          </span>
        </div>
      )}

      {token.phase === "SWEPT" && (
        <p className="card-note">
          Curve finished; its Uniswap pool is not created yet, so it is not tradeable
          here.
        </p>
      )}

      <div className="card-foot">
        <span className="card-label mono">{shortAddress(token.creatorAddress)}</span>
        <span className="card-label">
          {formatRelativeTime(new Date(token.createdAt))}
        </span>
        {token.hadWhitelistBundle && (
          <span className="badge" title="This launch pre-declared whitelisted buyers">
            {token.whitelistSize} whitelist
          </span>
        )}
      </div>
    </a>
  );
}
