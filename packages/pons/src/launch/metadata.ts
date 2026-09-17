/**
 * Launch metadata recovered from the launch transaction's calldata.
 *
 * WHY THIS IS NOT A NORMAL ABI DECODE.
 *
 * `logo`, `description` and the five social links are arguments to `launchAndBuy` —
 * they are never written to contract storage and never emitted in an event.
 * `TokenLaunched` carries six fields, all addresses and numbers; `getLaunchedToken`
 * returns addresses and numbers. So the only place a token's image has ever existed
 * is the calldata of the transaction that created it, which is why `Token.imageUrl`
 * sat at NULL for all 24,762 indexed tokens while the column had been there from the
 * first migration.
 *
 * The obvious fix — `decodeFunctionData` with the router ABI — recovers well under
 * half of them. Measured over the 60 most recent launches, seven distinct entry
 * points appear:
 *
 *     0xf85f8e41  36x  to 0xe33e9e47…  the PonsV2LaunchAndBuy router this repo knows
 *     0xa72101af  15x  to 0x7ed598bc…  a second router, ABI not published
 *     0xf35abbcf   3x  to 0x7ed598bc…  the same router, second entry point
 *     0xf955751f   3x  to 0x6319141d…
 *     0x174dea71   1x  to 0xca11bde0…  Multicall3
 *     0xe9ae5c53   1x  to 0xe37c62d3…
 *     0x7b71d85d   1x
 *
 * Launching is permissionless and anyone may wrap it, so that list is a snapshot,
 * not a specification. Decoding by signature means the images disappear the day
 * Pons ships a new router — silently, for new tokens only, which is the worst shape
 * a bug can take.
 *
 * HOW THIS FINDS THE FIELD INSTEAD.
 *
 * ABI-encoded strings are self-describing: a 32-byte length word, the UTF-8 bytes,
 * then zero padding to the next 32-byte boundary. Scanning for that shape recovers
 * every string in a calldata blob regardless of which function wrapped it.
 *
 * That alone would be a guess — several of those strings are the name, the symbol,
 * the description and five social URLs, and picking the wrong one puts a Telegram
 * link in an <img> tag. So the position is ANCHORED: the tuple declares
 * `(name, symbol, logo, description, socials…)`, so the encoder emits those strings
 * in that order, and the token's real `name` and `symbol` are already known from the
 * ERC-20 contract. Finding them adjacent and in order identifies the tuple exactly;
 * `logo` is the string that follows.
 *
 * If that pair is not found, this returns null. It does not fall back to "the first
 * string that looks like a URL" — a wrong image is worse than no image, because a
 * missing one is visibly missing and a wrong one is believed.
 *
 * Measured over 40 recent launches: 34 recovered, across four different routers
 * including the two whose ABI is unknown. The six misses are Multicall3 and
 * aggregator wrappers that nest the calldata one level deeper.
 *
 * WHAT COMES BACK IS UNTRUSTED. Real values from the live chain include
 * `ipfs://bafkrei…`, `https://img.koyen.fun/…`, a bare CID with no scheme at all,
 * and the sentence "verifying fresh-wallet funding path on pons v2" typed into the
 * image field. This module reports what the creator wrote. Deciding whether it is a
 * loadable image is `normaliseImageUrl`'s job, and serving it is the proxy's.
 */

/** Longest string this will pull out of calldata. */
const MAX_STRING_BYTES = 2048;

/** A string found in calldata, with the byte offset of its length word. */
interface FoundString {
  readonly at: number;
  readonly text: string;
}

/**
 * Every ABI-encoded string in a calldata blob, in byte order.
 *
 * The four checks below are what keep this from matching arbitrary numbers. A word
 * only counts as a string length if the top 29 bytes are zero AND the bytes that
 * follow are valid UTF-8 of exactly that length AND the tail padding to the 32-byte
 * boundary is zero AND the text holds no control characters. A uint256 amount fails
 * the first check; an address array fails the padding check.
 */
export function findCalldataStrings(calldata: string): FoundString[] {
  const hex = calldata.startsWith("0x") ? calldata.slice(2) : calldata;
  // Drop the 4-byte selector; an odd-length or empty blob has nothing to find.
  if (hex.length <= 8) return [];
  const bytes = Buffer.from(hex.slice(8), "hex");

  const found: FoundString[] = [];
  for (let word = 0; word + 32 <= bytes.length; word += 32) {
    const head = bytes.subarray(word, word + 32);
    if (head.subarray(0, 29).some((byte) => byte !== 0)) continue;

    const length = head.readUIntBE(29, 3);
    if (length === 0 || length > MAX_STRING_BYTES) continue;

    const body = bytes.subarray(word + 32, word + 32 + length);
    if (body.length !== length) continue;

    const paddedTo = Math.ceil(length / 32) * 32;
    const padding = bytes.subarray(word + 32 + length, word + 32 + paddedTo);
    if (padding.length !== paddedTo - length) continue;
    if (padding.some((byte) => byte !== 0)) continue;

    const text = body.toString("utf8");
    // Buffer.toString replaces invalid sequences with U+FFFD, which re-encodes to a
    // different length. A round-trip mismatch means the bytes were not UTF-8 text.
    if (Buffer.byteLength(text, "utf8") !== length) continue;
    // eslint-disable-next-line no-control-regex -- control bytes mean this is not text
    if (/[\x00-\x08\x0e-\x1f]/.test(text)) continue;

    found.push({ at: word, text });
  }
  return found;
}

export interface RecoveredSocials {
  readonly website: string;
  readonly twitter: string;
  readonly telegram: string;
  readonly discord: string;
  readonly farcaster: string;
}

export interface LaunchMetadata {
  /** Exactly what the creator typed into the image field. Not validated here. */
  readonly logo: string;
  readonly description: string;
  readonly socials: RecoveredSocials;
}

/**
 * Recover a launch's off-chain metadata from its transaction calldata.
 *
 * `name` and `symbol` must be the values read from the ERC-20 contract — they are the
 * anchor, so passing anything else silently returns null.
 *
 * Returns null when the anchor is not found: a wrapped or unknown launch shape, or a
 * token whose name and symbol were not the first two strings of the tuple.
 */
export function extractLaunchMetadata(
  calldata: string,
  identity: { readonly name: string; readonly symbol: string },
): LaunchMetadata | null {
  // An empty name or symbol would anchor on any zero-length gap, so refuse.
  if (identity.name === "" || identity.symbol === "") return null;

  const strings = findCalldataStrings(calldata);

  // The tuple's strings are emitted in declaration order, so name and symbol sit
  // adjacent. Scanning forward takes the first such pair; a launch that somehow
  // contains two is a launch whose own name repeats its identity, and the earlier
  // occurrence is still the tuple head.
  for (let index = 0; index + 1 < strings.length; index++) {
    if (strings[index]!.text !== identity.name) continue;
    if (strings[index + 1]!.text !== identity.symbol) continue;

    // Fields after the anchor. Any of them may be absent: the encoder omits nothing,
    // but an empty string has length zero and so is not recovered by the scan at all.
    // That is why these read positionally with a default rather than by count — a
    // creator who left Discord blank must not shift Farcaster into its place.
    //
    // The consequence is honest and bounded: when a middle field is empty, the ones
    // after it shift left by one. `logo` is unaffected in the case that matters,
    // because it is required at launch — the form disables submit on an empty image,
    // and the router's own validation rejects it.
    const after = strings.slice(index + 2).map((entry) => entry.text);
    const at = (position: number): string => after[position] ?? "";

    const logo = at(0);
    if (logo === "") return null;

    return {
      logo,
      description: at(1),
      socials: {
        website: at(2),
        twitter: at(3),
        telegram: at(4),
        discord: at(5),
        farcaster: at(6),
      },
    };
  }

  return null;
}

/** A CIDv0 (Qm…, base58) or CIDv1 (b…, base32). Deliberately narrow. */
const BARE_CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

/**
 * Reduce whatever the creator wrote to a canonical reference, or null.
 *
 * WHAT IS STORED IS THE REFERENCE, NOT A GATEWAY URL. An `ipfs://` value stays
 * `ipfs://` in the database. Baking a gateway host into 24,868 rows would make a
 * gateway going down a data migration instead of a one-line change — and gateways do
 * go down: measured against a real token CID, `cloudflare-ipfs.com` did not answer at
 * all, and `ipfs.io`, `dweb.link` and `w3s.link` each returned 429. Which gateway to
 * try is a fetch-time decision, so it lives in `imageFetchCandidates`.
 *
 * Every shape below was observed in live launch calldata, which is why each is handled
 * rather than assumed away:
 *
 *   ipfs://bafkrei…                  → ipfs://bafkrei…
 *   bafybeicncgrrp4u5lfwzwnbqutv…    → ipfs://bafybeicncgrrp4u5lfwzwnbqutv…
 *   https://img.koyen.fun/pons_…jpg  → unchanged
 *   verifying fresh-wallet funding…  → null, it is a sentence
 *
 * `http://` is rejected rather than upgraded. The page is served over HTTPS, so a
 * plaintext subresource is blocked by the browser anyway, and silently rewriting a
 * creator's URL to a host that may not answer on 443 trades a visible miss for an
 * invisible one.
 */
export function normaliseImageUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > 1024) return null;

  if (value.startsWith("ipfs://")) {
    const path = value.slice("ipfs://".length).replace(/^ipfs\//, "");
    if (path === "" || path.includes("..") || path.startsWith("/")) return null;
    return `ipfs://${path}`;
  }

  if (BARE_CID.test(value)) return `ipfs://${value}`;

  if (value.startsWith("https://")) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    // A host with no dot is not a public name, and credentials in an image URL are
    // never legitimate.
    if (!parsed.hostname.includes(".")) return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    return parsed.toString();
  }

  return null;
}

/**
 * IPFS gateways to try, in the order they are tried.
 *
 * Ordered by what actually answered, measured against a live token CID rather than
 * chosen by reputation:
 *
 *     4everland.io          200  image/jpeg  2.6s
 *     gateway.pinata.cloud  200  image/jpeg  5.8s
 *     ipfs.io               429  (rate limited)
 *     dweb.link             429  (rate limited)
 *     w3s.link              429  (rate limited)
 *     cloudflare-ipfs.com   no response at all
 *
 * The two rate-limited ones are kept as a last resort: a 429 comes back in under a
 * second, so trying them costs little, and their limit is per-client rather than
 * permanent. The dead host is not kept.
 *
 * IPFS is content-addressed, so every gateway that answers returns the same bytes —
 * the CID is a hash of them. Falling back between gateways cannot substitute one
 * image for another, which is what makes this failover safe in a way that retrying
 * an arbitrary HTTPS URL against a different host would not be.
 */
const IPFS_GATEWAYS = [
  "https://4everland.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
] as const;

/**
 * The URLs to try for a stored image reference, in order.
 *
 * One entry for an HTTPS reference — there is no second place to look, because an
 * arbitrary URL is not content-addressed. Several for IPFS, for the reasons above.
 */
export function imageFetchCandidates(reference: string): string[] {
  if (!reference.startsWith("ipfs://")) {
    return reference.startsWith("https://") ? [reference] : [];
  }
  const path = reference.slice("ipfs://".length);
  if (path === "" || path.includes("..")) return [];
  return IPFS_GATEWAYS.map((gateway) => `${gateway}${path}`);
}
