import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import {
  MAX_CONCURRENT_LOG_ADDRESS_QUERIES,
  MAX_LOG_ADDRESSES_PER_QUERY,
  RpcLogSource,
} from "./rpc.js";

function address(index: number): Address {
  return `0x${index.toString(16).padStart(40, "0")}` as Address;
}

describe("RpcLogSource address filters", () => {
  it("splits a curve set above the provider's 1,000-address selector limit", async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const source = new RpcLogSource({ getLogs } as unknown as PublicClient, 100n);
    const addresses = Array.from(
      { length: MAX_LOG_ADDRESSES_PER_QUERY + 1 },
      (_, index) => address(index + 1),
    );

    await expect(
      source.getLogs({ fromBlock: 500n, toBlock: 550n, addresses }),
    ).resolves.toEqual({ logs: [], reachedBlock: 550n });

    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(getLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fromBlock: 500n,
        toBlock: 550n,
        address: addresses.slice(0, MAX_LOG_ADDRESSES_PER_QUERY),
      }),
    );
    expect(getLogs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fromBlock: 500n,
        toBlock: 550n,
        address: addresses.slice(MAX_LOG_ADDRESSES_PER_QUERY),
      }),
    );
  });

  it("keeps an unfiltered query as one request", async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const source = new RpcLogSource({ getLogs } as unknown as PublicClient, 100n);

    await source.getLogs({ fromBlock: 500n, toBlock: 500n, addresses: [] });

    expect(getLogs).toHaveBeenCalledOnce();
    expect(getLogs).toHaveBeenCalledWith({ fromBlock: 500n, toBlock: 500n });
  });

  it("forwards topic0 OR filters to the RPC node and reserves selector capacity", async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const source = new RpcLogSource({ getLogs } as unknown as PublicClient, 100n);
    const topics = [
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    ] as const;
    const addresses = Array.from({ length: MAX_LOG_ADDRESSES_PER_QUERY }, (_, index) =>
      address(index + 1),
    );

    await source.getLogs({ fromBlock: 500n, toBlock: 500n, addresses, topics0: topics });

    // Seven topic selectors leave room for 993 addresses in the first query, not
    // 1,000 + 7 selectors which OrdoFi rejects.
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(getLogs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        address: addresses.slice(0, MAX_LOG_ADDRESSES_PER_QUERY - topics.length),
        topics: [topics],
      }),
    );
  });

  it("bounds concurrent address-group calls instead of bursting all groups at once", async () => {
    let active = 0;
    let peak = 0;
    const getLogs = vi.fn().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return [];
    });
    const source = new RpcLogSource({ getLogs } as unknown as PublicClient, 100n);
    const addresses = Array.from(
      { length: MAX_LOG_ADDRESSES_PER_QUERY * 3 },
      (_, index) => address(index + 1),
    );

    await source.getLogs({ fromBlock: 500n, toBlock: 500n, addresses });

    expect(getLogs).toHaveBeenCalledTimes(3);
    expect(peak).toBe(MAX_CONCURRENT_LOG_ADDRESS_QUERIES);
  });
});
