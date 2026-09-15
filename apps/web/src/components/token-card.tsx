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
 * Two disclosures are deliberate rather than decorative. A whitelist bundle is
 * declared, because a trader deserves to know the opening supply was concentrated
 * before they buy. And `SWEPT` is labelled as untradeable rather than shown as a
 * near-graduation success, because in that state the curve is drained and the Uniswap
 * pool does not exist yet.
 */

const PHASE_LABEL: Record<string, { text: string; tone: string }> = {
  NOT_GRADUATED: { text: "Curve", tone: "" },
  SWEPT: { text: "Pool pending", tone: "warn" },
  POOL_CREATED: { text: "Graduated", tone: "ok" },
  RESCUED: { text: "Rescued", tone: "warn" },
};

export function TokenCard({ token }: { token: SerialisedToken }) {
  const phase = PHASE_LABEL[token.phase] ?? { text: token.phase, tone: "" };
  const quoteDecimals = token.pairTokenDecimals;
  const isNative = /^0x0{40}$/i.test(token.pairTokenAddress);
  const quoteSymbol = isNative ? "ETH" : "tokens";

  return (
    <a href={`/token/${token.address}`} className="card">
      <div className="card-head">
        <div className="card-title">
          <span className="card-symbol">{token.symbol}</span>
          <span className="card-name">{token.name}</span>
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
          <span className="card-value mono">{token.tradeCount}</span>
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
        <p className="card-note warn-text">
          Curve finished, Uniswap pool not created yet — not tradeable right now.
        </p>
      )}

      <div className="card-foot">
        <span className="card-label mono">{shortAddress(token.creatorAddress)}</span>
        <span className="card-label">
          {formatRelativeTime(new Date(token.createdAt))}
        </span>
        {token.hadWhitelistBundle && (
          <span className="badge" title="This launch pre-declared whitelisted buyers">
            {token.whitelistSize} whitelisted
          </span>
        )}
      </div>
    </a>
  );
}
