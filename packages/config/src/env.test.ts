import { describe, expect, it } from "vitest";
import { loadClientEnv, loadServerEnv, liveTestsEnabled } from "./env.js";
import { ROBINHOOD_CHAIN_ID, robinhoodChain } from "./chain.js";
import { CONTRACTS, ZERO_ADDRESS, getChainContracts } from "./addresses.js";

/**
 * Environment validation is a safety boundary, not a convenience. A misconfigured
 * deployment must refuse to start rather than quietly point at the wrong chain or
 * the wrong contract, so every one of these rejections matters.
 */

const VALID_SERVER = {
  CHAIN_ID: "4663",
  RPC_ENDPOINTS: "https://robinhood.drpc.org,https://rpc.ordofi.network",
  PONS_V2_FACTORY: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  INDEXER_START_BLOCK: "26841846",
};

describe("server env", () => {
  it("accepts a valid configuration and parses the block as a bigint", () => {
    const env = loadServerEnv(VALID_SERVER as NodeJS.ProcessEnv);
    expect(env.CHAIN_ID).toBe(4663);
    expect(env.RPC_ENDPOINTS).toEqual([
      "https://robinhood.drpc.org",
      "https://rpc.ordofi.network",
    ]);
    // A block number is not a JS number: 852,912 blocks/day gets large fast.
    expect(env.INDEXER_START_BLOCK).toBe(26_841_846n);
  });

  it("refuses any chain other than Robinhood Chain", () => {
    expect(() =>
      loadServerEnv({ ...VALID_SERVER, CHAIN_ID: "1" } as NodeJS.ProcessEnv),
    ).toThrow(/only Robinhood Chain/i);
  });

  it("refuses a malformed factory address", () => {
    expect(() =>
      loadServerEnv({ ...VALID_SERVER, PONS_V2_FACTORY: "0xnope" } as NodeJS.ProcessEnv),
    ).toThrow(/valid EVM address/i);
  });

  it("refuses an empty RPC list", () => {
    expect(() =>
      loadServerEnv({ ...VALID_SERVER, RPC_ENDPOINTS: "" } as NodeJS.ProcessEnv),
    ).toThrow(/RPC endpoint/i);
  });

  it("refuses a non-URL RPC entry", () => {
    expect(() =>
      loadServerEnv({ ...VALID_SERVER, RPC_ENDPOINTS: "not-a-url" } as NodeJS.ProcessEnv),
    ).toThrow(/valid URL/i);
  });

  it("refuses a non-http scheme, which would silently never connect", () => {
    expect(() =>
      loadServerEnv({
        ...VALID_SERVER,
        RPC_ENDPOINTS: "wss://robinhood.example",
      } as NodeJS.ProcessEnv),
    ).toThrow(/http/i);
  });

  it("trims whitespace and drops empty entries in the RPC list", () => {
    const env = loadServerEnv({
      ...VALID_SERVER,
      RPC_ENDPOINTS: " https://a.example , , https://b.example ",
    } as NodeJS.ProcessEnv);
    expect(env.RPC_ENDPOINTS).toEqual(["https://a.example", "https://b.example"]);
  });

  it("names the offending field in the error, so a bad deploy is diagnosable", () => {
    try {
      loadServerEnv({ ...VALID_SERVER, PONS_V2_FACTORY: "bad" } as NodeJS.ProcessEnv);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("PONS_V2_FACTORY");
      expect((error as Error).message).toContain(".env.example");
    }
  });
});

describe("client env", () => {
  it("accepts a valid browser configuration", () => {
    const env = loadClientEnv({
      NEXT_PUBLIC_CHAIN_ID: "4663",
      NEXT_PUBLIC_RPC_ENDPOINTS: "https://robinhood.drpc.org",
      NEXT_PUBLIC_PONS_V2_FACTORY: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    });
    expect(env.NEXT_PUBLIC_CHAIN_ID).toBe(4663);
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
  });

  it("rejects a missing factory rather than defaulting to one", () => {
    expect(() =>
      loadClientEnv({
        NEXT_PUBLIC_CHAIN_ID: "4663",
        NEXT_PUBLIC_RPC_ENDPOINTS: "https://robinhood.drpc.org",
      }),
    ).toThrow();
  });
});

describe("live test gate", () => {
  it("is off unless explicitly enabled, so pnpm test stays hermetic", () => {
    expect(liveTestsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(liveTestsEnabled({ RUN_LIVE_TESTS: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(liveTestsEnabled({ RUN_LIVE_TESTS: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("chain definition", () => {
  it("matches the verified chain id", () => {
    expect(ROBINHOOD_CHAIN_ID).toBe(4663);
    expect(robinhoodChain.id).toBe(4663);
    expect(robinhoodChain.nativeCurrency.symbol).toBe("ETH");
    expect(robinhoodChain.nativeCurrency.decimals).toBe(18);
  });

  it("exposes contracts only for configured chains", () => {
    expect(getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2Factory).toBe(
      CONTRACTS[ROBINHOOD_CHAIN_ID]?.ponsV2Factory,
    );
    expect(() => getChainContracts(1)).toThrow(/No Pons contract configuration/i);
  });

  it("records the verified factory deploy block", () => {
    // Scanning from genesis would waste 26.8M blocks at ~101ms each.
    expect(getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2FactoryDeployBlock).toBe(
      26_841_846n,
    );
  });

  it("provides the native-ETH sentinel so no other package needs an address literal", () => {
    expect(ZERO_ADDRESS).toMatch(/^0x0{40}$/);
  });
});

describe("NEXT_PUBLIC_OFFICIAL_TOKEN", () => {
  const base = {
    NEXT_PUBLIC_RPC_ENDPOINTS: "https://robinhood.drpc.org",
    NEXT_PUBLIC_PONS_V2_FACTORY: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  };

  it("is absent when unset", () => {
    expect(loadClientEnv(base).NEXT_PUBLIC_OFFICIAL_TOKEN).toBeUndefined();
  });

  it("treats an empty value as absent", () => {
    // So the variable can sit blank in a deployment's settings until launch day,
    // rather than needing a code change then.
    expect(
      loadClientEnv({ ...base, NEXT_PUBLIC_OFFICIAL_TOKEN: "" }).NEXT_PUBLIC_OFFICIAL_TOKEN,
    ).toBeUndefined();
    expect(
      loadClientEnv({ ...base, NEXT_PUBLIC_OFFICIAL_TOKEN: "   " })
        .NEXT_PUBLIC_OFFICIAL_TOKEN,
    ).toBeUndefined();
  });

  it("accepts an address", () => {
    const address = "0xF8767D5e0976782a4CD9410E688F1383aBc1cc70";
    expect(
      loadClientEnv({ ...base, NEXT_PUBLIC_OFFICIAL_TOKEN: address })
        .NEXT_PUBLIC_OFFICIAL_TOKEN,
    ).toBe(address);
  });

  it("refuses a value that is not an address", () => {
    // A typo here would spotlight nothing, silently. Better to fail the boot.
    expect(() =>
      loadClientEnv({ ...base, NEXT_PUBLIC_OFFICIAL_TOKEN: "stunks" }),
    ).toThrow(/valid EVM address/);
  });
});
