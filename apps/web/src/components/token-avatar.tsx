import { normaliseImageUrl } from "@stunks/pons";

/**
 * A token's avatar: its creator-supplied image when there is a usable one, and a
 * deterministic letter mark when there is not.
 *
 * NO JAVASCRIPT IS INVOLVED IN THE FALLBACK. The letter mark is the element's own
 * content and the image sits on top of it, so a URL that 404s, times out or serves
 * something that is not an image simply reveals the mark underneath. An `onError`
 * handler would mean making every card a client component and shipping a hydration
 * boundary per token to handle the case where a stranger's server is down — for a
 * fallback CSS already does for free, at render time, with no flash.
 *
 * `alt=""` is what makes that work: it marks the image decorative, so a browser that
 * fails to load it renders nothing at all rather than a broken-image icon. The symbol
 * is already in the adjacent text, so the image carries no information a screen reader
 * would miss.
 *
 * The URL is never used directly — see the proxy route for why the visitor's browser
 * must not connect to a creator-chosen host.
 */

function letterMark(symbol: string): string {
  return (
    symbol
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

export function TokenAvatar({
  symbol,
  imageUrl,
  className = "",
}: {
  readonly symbol: string;
  readonly imageUrl: string | null;
  readonly className?: string;
}) {
  // Re-normalised at render: what is stored came from untrusted calldata, and a value
  // written before the rules tightened must not be rendered under the old ones.
  const source = imageUrl === null ? null : normaliseImageUrl(imageUrl);

  return (
    <span className={`token-avatar ${className}`.trim()} aria-hidden="true">
      {letterMark(symbol)}
      {source !== null && (
        <img
          className="token-avatar-img"
          src={`/api/token-image?url=${encodeURIComponent(imageUrl ?? "")}`}
          alt=""
          loading="lazy"
          decoding="async"
          // Belt and braces. The request is same-origin so no referrer would leak to
          // the creator's host anyway, but the proxy is a public endpoint and this
          // keeps the token address out of its logs.
          referrerPolicy="no-referrer"
        />
      )}
    </span>
  );
}
