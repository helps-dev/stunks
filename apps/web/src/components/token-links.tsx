/**
 * A token's creator-written description and social links.
 *
 * All of it comes from the launch transaction's calldata, which means all of it was
 * typed by a stranger. Two consequences are enforced here rather than assumed:
 *
 * 1. THE DESCRIPTION IS TEXT, NEVER MARKUP. React escapes it, so there is nothing to
 *    inject — but it is also clamped, because "description" is a free-form string and
 *    a launch may carry a thousand characters of it.
 *
 * 2. A LINK IS NOT AN ENDORSEMENT, AND MUST NOT LEAK THE VISITOR. `rel="noreferrer"`
 *    keeps the destination from learning which token page sent the visitor;
 *    `nofollow ugc` keeps STUNKS from lending its ranking to a URL nobody reviewed;
 *    `noopener` keeps the opened tab from reaching back into this one.
 *
 * Only `https:` links are rendered. A creator may write anything in these fields,
 * including `javascript:` — React would refuse to render that as an href with a
 * warning, which is a safety net rather than a policy, so the policy is here.
 */

interface SocialLink {
  readonly label: string;
  readonly url: string | null;
}

/** An https URL, or null. Same rule as the image fields, for the same reason. */
function safeUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("https://")) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username !== "" || parsed.password !== "") return null;
    if (!parsed.hostname.includes(".")) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function TokenLinks({
  description,
  websiteUrl,
  twitterUrl,
  telegramUrl,
  discordUrl,
  farcasterUrl,
}: {
  readonly description: string | null;
  readonly websiteUrl: string | null;
  readonly twitterUrl: string | null;
  readonly telegramUrl: string | null;
  readonly discordUrl: string | null;
  readonly farcasterUrl: string | null;
}) {
  const links: SocialLink[] = [
    { label: "Website", url: safeUrl(websiteUrl) },
    { label: "X", url: safeUrl(twitterUrl) },
    { label: "Telegram", url: safeUrl(telegramUrl) },
    { label: "Discord", url: safeUrl(discordUrl) },
    { label: "Farcaster", url: safeUrl(farcasterUrl) },
  ];
  const usable = links.filter(
    (link): link is { label: string; url: string } => link.url !== null,
  );
  const text = description?.trim() ?? "";

  // Nothing written means nothing rendered — not an empty panel implying the creator
  // was asked and declined.
  if (text === "" && usable.length === 0) return null;

  return (
    <section className="token-about">
      {text !== "" && <p className="token-about-text">{text}</p>}
      {usable.length > 0 && (
        <div className="token-about-links">
          {usable.map((link) => (
            <a
              key={link.label}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer nofollow ugc"
            >
              {link.label} ↗
            </a>
          ))}
        </div>
      )}
      <p className="token-about-note">
        Written by the token&apos;s creator at launch. STUNKS does not verify any of it.
      </p>
    </section>
  );
}
