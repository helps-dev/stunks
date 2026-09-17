import { imageFetchCandidates, normaliseImageUrl } from "@stunks/pons";
import { NextResponse } from "next/server";

/**
 * Token image proxy.
 *
 * Token images are arbitrary URLs typed by strangers at launch time and recovered
 * from transaction calldata. Three things follow, and this route exists because of
 * all three:
 *
 * 1. THE VISITOR'S IP DOES NOT GO TO THE CREATOR'S SERVER. Putting a raw creator URL
 *    in an <img src> makes every visitor's browser connect to a host the creator
 *    chose, which hands that host an IP address, a user agent and a referrer for
 *    everyone who scrolls past the token. The creator picked the URL; they should not
 *    get an audience log with it. Fetching server-side means the host sees this
 *    deployment, once, and nothing about who was looking.
 *
 * 2. THE CONTENT SECURITY POLICY STAYS TIGHT. `img-src` is `'self' data: blob:`.
 *    Rendering creator URLs directly would mean widening it to `https:` — every host
 *    on the internet — for the sake of pictures. Proxying keeps every image
 *    same-origin, so the policy does not move.
 *
 * 3. WHAT COMES BACK IS NOT ASSUMED TO BE AN IMAGE. A URL ending in .png can serve
 *    HTML, a 400 MB file, or a redirect to an internal address. Hence the
 *    content-type allowlist, the byte cap, and redirects that are followed by hand
 *    with every hop re-checked rather than by the fetch implementation.
 *
 * SVG IS NOT ALLOWED. An SVG is a document: it can carry <script>, and the browser
 * runs it in this origin when it is same-origin, which is exactly what proxying makes
 * it. Raster formats cannot do that. Excluding SVG costs a handful of legitimate
 * logos and removes stored XSS from the threat model entirely.
 *
 * A FAILURE IS A 404, NOT A BROKEN PAGE. Every miss — bad URL, dead host, wrong type,
 * too large, too slow — returns 404 and the card falls back to its letter mark. The
 * page is never held up by someone else's server.
 *
 * IPFS IS TRIED ACROSS SEVERAL GATEWAYS, WITHIN ONE DEADLINE. Most token images are
 * IPFS, and the public gateways are unreliable: measured against a live token CID,
 * three of six returned 429 and one did not answer at all. A single hardcoded gateway
 * would have failed the majority of images. The candidates and their order live in
 * @stunks/pons; what belongs here is the time budget, because the constraint is this
 * function's, not IPFS's — a Vercel serverless function is killed at 10 seconds, so
 * the whole attempt sequence must finish inside that or the visitor gets a 504 with
 * an empty body instead of a fallback avatar.
 */

export const runtime = "nodejs";

/** Formats a browser renders and a script cannot hide in. No SVG — see above. */
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/**
 * 4 MB, which is the platform's ceiling rather than a preference.
 *
 * A Vercel serverless function cannot return a response body larger than 4.5 MB, so
 * anything above this could not be delivered even if it were fetched — it would fail
 * as a 500 instead of falling back to the letter mark.
 *
 * This was 3 MB, chosen as "larger than any legitimate token logo". Measured against
 * real launches, it is not: one live token ships a 3.8 MB PNG and another a 2.8 MB
 * one, so a 3 MB cap would have quietly dropped real images as oversized. Creators do
 * upload full-resolution artwork for a 37-pixel avatar.
 */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * How long one gateway gets before the next is tried — except the last, which gets
 * whatever remains of the budget.
 *
 * Measured, not guessed. This was 4 seconds, just under `gateway.pinata.cloud`'s
 * typical 4.5, which made the most reliable gateway look like the least. Pinata has
 * since been measured at 5–6.4 seconds on a 1.4 MB image, so no fixed slice short
 * enough to leave room for a fallback will ever fit it — which is the point of
 * trying a faster gateway first rather than waiting longer.
 */
const ATTEMPT_TIMEOUT_MS = 4_000;

/**
 * Redirect hops followed per attempt.
 *
 * `redirect: "follow"` is not usable here: the URL comes from a stranger, so a
 * redirect could walk to a private address and turn this into an SSRF. But refusing
 * redirects outright is not usable either — `4everland.io/ipfs/<cid>` answers 301 to
 * its own subdomain gateway, so treating a 3xx as a failure silently disabled the
 * fastest gateway. Each hop is therefore re-validated by the same rules as the first.
 */
const MAX_REDIRECTS = 2;

/**
 * The whole request's budget, under Vercel's 10-second function limit.
 *
 * Attempts stop when this is spent even if candidates remain, because a 404 the card
 * can fall back from beats a 504 it cannot.
 */
const TOTAL_BUDGET_MS = 8_500;

/** A hit is immutable: the calldata it came from cannot change. */
const CACHE_HIT = "public, max-age=86400, s-maxage=604800, immutable";

/** A miss is cached too, briefly — a dead host must not be re-fetched per visitor. */
const CACHE_MISS = "public, max-age=300, s-maxage=300";

/**
 * A miss, with every reason it missed for.
 *
 * All of them, not just the last: reporting only the final failure made a Pinata
 * timeout and a 4everland redirect both show up as `ipfs.io` returning 429, which
 * pointed at rate limiting when neither cause was rate limiting. A header that names
 * each gateway's own outcome is the difference between diagnosing this from a browser
 * network tab and guessing at it.
 */
function miss(reasons: readonly string[]): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: {
      "Cache-Control": CACHE_MISS,
      "X-Image-Miss": reasons.join(", ").slice(0, 200) || "none",
    },
  });
}

/**
 * A URL this is willing to fetch: HTTPS, a public-looking host, no credentials.
 *
 * Applied to redirect targets as well as the first URL, because a redirect is a URL
 * chosen by the same untrusted party.
 */
function fetchable(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".")) return null;
  // Literal private and loopback addresses. DNS can still resolve a public name to a
  // private address, which this cannot see — the content-type allowlist and the byte
  // cap are what bound the damage if it does.
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return null;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return null;
  }
  return parsed.toString();
}

/**
 * One attempt at one gateway, following its redirects by hand.
 *
 * The whole hop chain shares one deadline, so a gateway that redirects cannot spend
 * more of the budget than one that answers directly.
 */
async function attempt(
  startUrl: string,
  budgetMs: number,
): Promise<{ body: Uint8Array; type: string } | { reason: string }> {
  const deadline = Date.now() + budgetMs;
  let url: string | null = fetchable(startUrl);
  if (url === null) return { reason: "unfetchable" };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const remaining = deadline - Date.now();
    if (remaining < 250) return { reason: "timeout" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const upstream = await fetch(url, {
        signal: controller.signal,
        // Manual, so each hop is re-checked by `fetchable` before it is followed.
        redirect: "manual",
        headers: { Accept: "image/*" },
        // Nothing about this deployment or its visitors travels upstream.
        referrerPolicy: "no-referrer",
      });

      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get("location");
        if (location === null) return { reason: `redirect-${upstream.status}-no-location` };
        // Relative targets resolve against the hop that issued them.
        const next: string | null = fetchable(new URL(location, url).toString());
        if (next === null) return { reason: "redirect-blocked" };
        url = next;
        continue;
      }

      if (!upstream.ok) return { reason: `http-${upstream.status}` };

      const type = (upstream.headers.get("content-type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      if (!ALLOWED_TYPES.has(type)) return { reason: `type-${type || "none"}` };

      // Trust the declared length only to reject early; the real cap is on the bytes.
      // eslint-disable-next-line no-restricted-syntax -- a byte count is not money
      const declared = Number(upstream.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_BYTES) return { reason: "too-large" };

      const body = new Uint8Array(await upstream.arrayBuffer());
      if (body.byteLength > MAX_BYTES) return { reason: "too-large" };
      if (body.byteLength === 0) return { reason: "empty" };

      return { body, type };
    } catch (error) {
      return {
        reason: error instanceof Error && error.name === "AbortError" ? "timeout" : "fetch",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { reason: "too-many-redirects" };
}

export async function GET(request: Request): Promise<NextResponse> {
  const raw = new URL(request.url).searchParams.get("url");
  if (raw === null) return miss(["no-url"]);

  // Same normaliser the indexer used, so what is stored and what is fetched agree.
  // It is re-run rather than trusted: this endpoint is public, and the query string
  // is as untrusted as the calldata was.
  const reference = normaliseImageUrl(raw);
  if (reference === null) return miss(["not-an-image-url"]);

  const candidates = imageFetchCandidates(reference);
  if (candidates.length === 0) return miss(["no-candidate"]);

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const reasons: string[] = [];
  for (const candidate of candidates) {
    const remaining = deadline - Date.now();
    // A sliver of budget is not worth an attempt: it would abort mid-flight and
    // spend the connection for nothing.
    if (remaining < 750) {
      reasons.push("budget-spent");
      break;
    }
    // The LAST candidate gets everything that is left, not a fixed slice. There is
    // nothing to save it for, and a single-candidate URL — any image that is not on
    // IPFS — would otherwise be cut off at the per-attempt limit while the budget
    // still had seconds in it.
    const isLast = candidate === candidates[candidates.length - 1];
    const result = await attempt(candidate, isLast ? remaining : Math.min(ATTEMPT_TIMEOUT_MS, remaining));
    if ("body" in result) {
      return new NextResponse(result.body, {
        status: 200,
        headers: {
          "Content-Type": result.type,
          "Content-Length": String(result.body.byteLength),
          "Cache-Control": CACHE_HIT,
          // Defence in depth: even if an allowed type somehow carried markup, this
          // stops the browser sniffing its way to executing it.
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
        },
      });
    }
    reasons.push(`${new URL(candidate).hostname}:${result.reason}`);
  }

  return miss(reasons);
}
