import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import {
  extractLaunchMetadata,
  findCalldataStrings,
  imageFetchCandidates,
  normaliseImageUrl,
} from "./metadata.js";

/**
 * The tests encode with viem rather than pasting hex, so they exercise a real ABI
 * encoder. The point of the module is that it does NOT need the right ABI, so several
 * cases deliberately encode with a shape this repo has no ABI for.
 */

const launchAbi = parseAbi([
  "struct Socials { string website; string twitter; string telegram; string discord; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchAndBuy(TokenParams tokenParams, uint256 launchConfigId, address pairToken, uint256 quoteIn)",
]);

const EMPTY_SOCIALS: Record<
  "website" | "twitter" | "telegram" | "discord" | "farcaster",
  string
> = {
  website: "",
  twitter: "",
  telegram: "",
  discord: "",
  farcaster: "",
};

function encodeLaunch(params: {
  name: string;
  symbol: string;
  logo: string;
  description?: string;
  socials?: typeof EMPTY_SOCIALS;
}): string {
  return encodeFunctionData({
    abi: launchAbi,
    functionName: "launchAndBuy",
    args: [
      {
        name: params.name,
        symbol: params.symbol,
        logo: params.logo,
        description: params.description ?? "",
        socials: params.socials ?? EMPTY_SOCIALS,
        creatorFeeRecipient: "0x1111111111111111111111111111111111111111",
        creatorTaxBps: 100,
        buybackEnabled: true,
        expectedEconomics: `0x${"22".repeat(32)}`,
        salt: `0x${"33".repeat(32)}`,
      },
      1n,
      "0x0000000000000000000000000000000000000000",
      0n,
    ],
  });
}

describe("findCalldataStrings", () => {
  it("finds the strings in a launch, in tuple order", () => {
    const data = encodeLaunch({
      name: "Museum Realm",
      symbol: "MUSEREALM",
      logo: "ipfs://bafkreihsy3jo7a7iqqwtnyqb4bf4gl6koodgj5gd7bngjo7ans6uif",
      description: "a realm",
    });
    expect(findCalldataStrings(data).map((entry) => entry.text)).toEqual([
      "Museum Realm",
      "MUSEREALM",
      "ipfs://bafkreihsy3jo7a7iqqwtnyqb4bf4gl6koodgj5gd7bngjo7ans6uif",
      "a realm",
    ]);
  });

  it("does not mistake numbers or addresses for strings", () => {
    // The encoded launch above carries a uint256, two bytes32 and an address. None of
    // them may appear as text.
    const data = encodeLaunch({ name: "N", symbol: "S", logo: "ipfs://cid" });
    const texts = findCalldataStrings(data).map((entry) => entry.text);
    expect(texts).toEqual(["N", "S", "ipfs://cid"]);
  });

  it("returns nothing for calldata that is only a selector", () => {
    expect(findCalldataStrings("0xdeadbeef")).toEqual([]);
    expect(findCalldataStrings("0x")).toEqual([]);
  });
});

describe("extractLaunchMetadata", () => {
  it("recovers the logo from a launch", () => {
    const data = encodeLaunch({
      name: "Doodled",
      symbol: "$DOODLED",
      logo: "https://ipfs.erebrus.io/ipfs/bafybeif5tr3lmmvkvxmttoowhch74mlo",
      description: "the doodle",
      socials: { ...EMPTY_SOCIALS, website: "https://x.com/klk" },
    });
    const meta = extractLaunchMetadata(data, { name: "Doodled", symbol: "$DOODLED" });
    expect(meta?.logo).toBe(
      "https://ipfs.erebrus.io/ipfs/bafybeif5tr3lmmvkvxmttoowhch74mlo",
    );
    expect(meta?.description).toBe("the doodle");
    expect(meta?.socials.website).toBe("https://x.com/klk");
  });

  /**
   * The reason the module scans instead of decoding. This encodes through a function
   * signature that does not exist anywhere in this repo — a stand-in for router
   * 0x7ed598bc…, which accounts for 30% of live launches and whose ABI is not
   * published. A signature-based decoder returns nothing here.
   */
  it("recovers the logo through an unknown wrapper function", () => {
    const unknownAbi = parseAbi([
      "struct Socials { string website; string twitter; string telegram; string discord; string farcaster; }",
      "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
      "function createAndSnipe(address referrer, TokenParams params, uint64 deadline)",
    ]);
    const data = encodeFunctionData({
      abi: unknownAbi,
      functionName: "createAndSnipe",
      args: [
        "0x4444444444444444444444444444444444444444",
        {
          name: "Northern Union",
          symbol: "NORTHERN UNION",
          logo: "ipfs://bafkreihz7cwnntojf3rkhfbweln62uwij4eorkbfnbccbi62az5fx3",
          description: "",
          socials: EMPTY_SOCIALS,
          creatorFeeRecipient: "0x1111111111111111111111111111111111111111",
          creatorTaxBps: 0,
          buybackEnabled: false,
          expectedEconomics: `0x${"00".repeat(32)}`,
          salt: `0x${"01".repeat(32)}`,
        },
        123n,
      ],
    });
    expect(
      extractLaunchMetadata(data, { name: "Northern Union", symbol: "NORTHERN UNION" })
        ?.logo,
    ).toBe("ipfs://bafkreihz7cwnntojf3rkhfbweln62uwij4eorkbfnbccbi62az5fx3");
  });

  it("returns null when the identity does not match, rather than guessing", () => {
    const data = encodeLaunch({
      name: "Real Name",
      symbol: "REAL",
      logo: "ipfs://cid",
    });
    // A token whose ERC-20 identity differs from the calldata is not this tuple, so
    // no field may be read out of it.
    expect(extractLaunchMetadata(data, { name: "Other", symbol: "OTHER" })).toBeNull();
  });

  it("does not anchor on an empty name or symbol", () => {
    const data = encodeLaunch({ name: "N", symbol: "S", logo: "ipfs://cid" });
    expect(extractLaunchMetadata(data, { name: "", symbol: "S" })).toBeNull();
    expect(extractLaunchMetadata(data, { name: "N", symbol: "" })).toBeNull();
  });

  it("returns null for a wrapped call whose strings are out of reach", () => {
    // Multicall3 nests the launch one level deeper, inside bytes. Nothing is
    // recovered, and nothing is invented.
    const multicall = parseAbi([
      "struct Call { address target; bytes callData; }",
      "function aggregate(Call[] calls)",
    ]);
    const data = encodeFunctionData({
      abi: multicall,
      functionName: "aggregate",
      args: [
        [
          {
            target: "0x5555555555555555555555555555555555555555",
            callData: "0xdeadbeef",
          },
        ],
      ],
    });
    expect(extractLaunchMetadata(data, { name: "Hire", symbol: "HIRE" })).toBeNull();
  });
});

describe("normaliseImageUrl", () => {
  it("keeps an ipfs reference as a reference, not a gateway URL", () => {
    // Storing a gateway host would make a gateway outage a data migration.
    expect(normaliseImageUrl("ipfs://bafkreiabc")).toBe("ipfs://bafkreiabc");
  });

  it("promotes a bare CID to an ipfs reference", () => {
    // Observed live: DILBERT shipped a CIDv1 with no scheme at all.
    const cid = "bafybeicncgrrp4u5lfwzwnbqutvzrsgtbondss7avd7s6ac4uo3vq5z5bq";
    expect(normaliseImageUrl(cid)).toBe(`ipfs://${cid}`);
  });

  it("strips a redundant ipfs/ prefix", () => {
    expect(normaliseImageUrl("ipfs://ipfs/bafkreiabc")).toBe("ipfs://bafkreiabc");
  });

  it("keeps an https URL", () => {
    expect(normaliseImageUrl("https://img.koyen.fun/pons_7635048945.jpg")).toBe(
      "https://img.koyen.fun/pons_7635048945.jpg",
    );
  });

  it("rejects a sentence typed into the image field", () => {
    // Observed live: GPRF.
    expect(normaliseImageUrl("verifying fresh-wallet funding path on pons v2")).toBeNull();
  });

  it("rejects plaintext, data, javascript and credentialled URLs", () => {
    expect(normaliseImageUrl("http://example.com/a.png")).toBeNull();
    expect(normaliseImageUrl("data:image/svg+xml,<svg onload=alert(1)>")).toBeNull();
    expect(normaliseImageUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseImageUrl("https://user:pass@example.com/a.png")).toBeNull();
    expect(normaliseImageUrl("https://localhost/a.png")).toBeNull();
  });

  it("rejects gateway path traversal", () => {
    expect(normaliseImageUrl("ipfs://../../etc/passwd")).toBeNull();
    expect(normaliseImageUrl("ipfs:///etc/passwd")).toBeNull();
  });

  it("rejects empty and oversized values", () => {
    expect(normaliseImageUrl("   ")).toBeNull();
    expect(normaliseImageUrl(`https://example.com/${"a".repeat(2000)}`)).toBeNull();
  });
});

describe("imageFetchCandidates", () => {
  it("offers several gateways for an ipfs reference", () => {
    // Three of six public gateways were rate-limited or dead when measured, so one
    // hardcoded host would fail most images.
    const candidates = imageFetchCandidates("ipfs://bafkreiabc");
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every((url) => url.endsWith("bafkreiabc"))).toBe(true);
    expect(new Set(candidates).size).toBe(candidates.length);
    for (const url of candidates) expect(url.startsWith("https://")).toBe(true);
  });

  it("offers exactly one candidate for an https URL", () => {
    // An arbitrary URL is not content-addressed, so there is no second place to look.
    expect(imageFetchCandidates("https://img.koyen.fun/a.jpg")).toEqual([
      "https://img.koyen.fun/a.jpg",
    ]);
  });

  it("offers nothing for a reference it cannot place", () => {
    expect(imageFetchCandidates("ftp://example.com/a.png")).toEqual([]);
    expect(imageFetchCandidates("ipfs://")).toEqual([]);
    expect(imageFetchCandidates("ipfs://../secret")).toEqual([]);
  });
});

describe("gateway URLs are recognised as ipfs references", () => {
  const CID = "QmRy4k3bjna32cMHYuAzRGNFAvHTPaNmUuwFoApHc236ds";

  it("reduces a path-style gateway URL to its CID", () => {
    // STUNKS' own token shipped exactly this. Kept as a URL it has one place to be
    // fetched from, and that place served 1.4 MB in 6.4s and timed out; 4everland
    // returned the identical bytes in 1.2s.
    expect(normaliseImageUrl(`https://gateway.pinata.cloud/ipfs/${CID}`)).toBe(
      `ipfs://${CID}`,
    );
    expect(normaliseImageUrl(`https://ipfs.io/ipfs/${CID}`)).toBe(`ipfs://${CID}`);
  });

  it("reduces a subdomain-style gateway URL to its CID", () => {
    const b32 = "bafybeicncgrrp4u5lfwzwnbqutvzrsgtbondss7avd7s6ac4uo3vq5z5bq";
    expect(normaliseImageUrl(`https://${b32}.ipfs.4everland.io/`)).toBe(`ipfs://${b32}`);
  });

  it("keeps a sub-path, which addresses a file inside a directory CID", () => {
    expect(normaliseImageUrl(`https://gateway.pinata.cloud/ipfs/${CID}/logo.png`)).toBe(
      `ipfs://${CID}/logo.png`,
    );
  });

  it("gives a reduced gateway URL the full candidate list", () => {
    const candidates = imageFetchCandidates(
      normaliseImageUrl(`https://gateway.pinata.cloud/ipfs/${CID}`)!,
    );
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.some((url) => url.includes("4everland"))).toBe(true);
  });

  it("leaves an ordinary https image URL alone", () => {
    // Not content-addressed: another host would be another image, so there is no
    // safe fallback and none is invented.
    expect(normaliseImageUrl("https://img.koyen.fun/pons_123.jpg")).toBe(
      "https://img.koyen.fun/pons_123.jpg",
    );
    expect(imageFetchCandidates("https://img.koyen.fun/pons_123.jpg")).toHaveLength(1);
  });

  it("does not treat a path that merely mentions ipfs as a gateway", () => {
    expect(normaliseImageUrl("https://example.com/ipfs/not-a-cid.png")).toBe(
      "https://example.com/ipfs/not-a-cid.png",
    );
    expect(normaliseImageUrl("https://example.com/my-ipfs-photos/a.png")).toBe(
      "https://example.com/my-ipfs-photos/a.png",
    );
  });
});
