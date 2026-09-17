import { describe, expect, it, vi } from "vitest";
import { numberToHex, type Address, type PublicClient } from "viem";
import type { RpcPool } from "@stunks/web3";
import {
  MAX_CONCURRENT_LOG_ADDRESS_QUERIES,
  MAX_LOG_ADDRESSES_PER_QUERY,
  RpcLogSource,
} from "./rpc.js";

function address(index: number): Address {
  return `0x${index.toString(16).padStart(40, "0")}` as Address;
}

/**
 * These assert the JSON-RPC parameters themselves, not a client method call, and that
 * is deliberate.
 *
 * The source used to go through viem's `getLogs`, which derives `topics` from its own
 * `event`/`events` options and silently drops a raw `topics` array — it put
 * `"topics": []` on the wire, which a node reads as "no filter". Every test passed,
 * because they asserted the arguments handed to `getLogs` rather than what left the
 * process. Measured cost over 100 blocks: 4,097 logs returned where 63 were wanted.
 */
function harness(logs: unknown[] = []) {
  const request = vi.fn().mockResolvedValue(logs);
  const pool = { request } as unknown as RpcPool;
  const source = new RpcLogSource({} as unknown as PublicClient, 100n, pool);
  return { source, request };
}

/** The filter object of the Nth eth_getLogs call. */
function filterOf(request: ReturnType<typeof vi.fn>, nth: number) {
  const call = request.mock.calls[nth - 1];
  expect(call?.[0]).toBe("eth_getLogs");
  return (call?.[1] as [Record<string, unknown>])[0];
}

describe("RpcLogSource request parameters", () => {
  it("sends topic0 as a nested OR filter, which is what a node applies", async () => {
    const { source, request } = harness();
    const topics = [
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ] as const;

    await source.getLogs({
      fromBlock: 500n,
      toBlock: 550n,
      addresses: [],
      topics0: topics,
    });

    // `[[a, b]]` is "topic0 is a OR b". A flat `[a, b]` would mean "topic0 is a AND
    // topic1 is b", which matches nothing — the two are easy to confuse and the
    // difference is invisible until you count the logs that come back.
    expect(filterOf(request, 1)).toEqual({
      fromBlock: numberToHex(500n),
      toBlock: numberToHex(550n),
      topics: [[...topics]],
    });
  });

  it("sends block numbers as hex, as the JSON-RPC schema requires", async () => {
    const { source, request } = harness();
    await source.getLogs({ fromBlock: 1_000n, toBlock: 1_005n, addresses: [] });
    expect(filterOf(request, 1)).toMatchObject({
      fromBlock: "0x3e8",
      toBlock: "0x3ed",
    });
  });

  it("omits the filter keys entirely when there is nothing to filter on", async () => {
    const { source, request } = harness();
    await source.getLogs({ fromBlock: 500n, toBlock: 500n, addresses: [] });

    const filter = filterOf(request, 1);
    expect(request).toHaveBeenCalledOnce();
    expect(filter).not.toHaveProperty("address");
    expect(filter).not.toHaveProperty("topics");
  });

  it("decodes the hex wire shape into the types the processors expect", async () => {
    const { source } = harness([
      {
        address: address(7),
        topics: ["0xaa"],
        data: "0x",
        blockNumber: "0x1f4",
        blockHash: "0xbb",
        transactionHash: "0xcc",
        logIndex: "0x2a",
      },
    ]);

    const batch = await source.getLogs({ fromBlock: 500n, toBlock: 500n, addresses: [] });

    expect(batch.logs).toEqual([
      {
        address: address(7),
        topics: ["0xaa"],
        data: "0x",
        blockNumber: 500n,
        blockHash: "0xbb",
        transactionHash: "0xcc",
        logIndex: 42,
      },
    ]);
  });

  it("still discards a log the node returned despite the topic filter", async () => {
    // Defence in depth: an endpoint that ignores `topics` is contained here rather
    // than reaching the processors. This is the filter that kept the indexer correct
    // while the server-side one was silently absent.
    const wanted = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { source } = harness([
      {
        address: address(1),
        topics: [wanted],
        data: "0x",
        blockNumber: "0x1f4",
        blockHash: "0xbb",
        transactionHash: "0xcc",
        logIndex: "0x0",
      },
      {
        address: address(2),
        topics: ["0x9999999999999999999999999999999999999999999999999999999999999999"],
        data: "0x",
        blockNumber: "0x1f4",
        blockHash: "0xbb",
        transactionHash: "0xdd",
        logIndex: "0x1",
      },
    ]);

    const batch = await source.getLogs({
      fromBlock: 500n,
      toBlock: 500n,
      addresses: [],
      topics0: [wanted],
    });

    expect(batch.logs).toHaveLength(1);
    expect(batch.logs[0]?.address).toBe(address(1));
  });
});

describe("RpcLogSource address filters", () => {
  it("splits a curve set above the provider's 1,000-address selector limit", async () => {
    const { source, request } = harness();
    const addresses = Array.from(
      { length: MAX_LOG_ADDRESSES_PER_QUERY + 1 },
      (_, index) => address(index + 1),
    );

    await expect(
      source.getLogs({ fromBlock: 500n, toBlock: 550n, addresses }),
    ).resolves.toEqual({ logs: [], reachedBlock: 550n });

    expect(request).toHaveBeenCalledTimes(2);
    expect(filterOf(request, 1)).toMatchObject({
      address: addresses.slice(0, MAX_LOG_ADDRESSES_PER_QUERY),
    });
    expect(filterOf(request, 2)).toMatchObject({
      address: addresses.slice(MAX_LOG_ADDRESSES_PER_QUERY),
    });
  });

  it("reserves selector capacity for the topic filter", async () => {
    const { source, request } = harness();
    const topics = Array.from(
      { length: 7 },
      (_, i) => `0x${String(i).repeat(64)}`.slice(0, 66) as `0x${string}`,
    );
    const addresses = Array.from({ length: MAX_LOG_ADDRESSES_PER_QUERY }, (_, index) =>
      address(index + 1),
    );

    await source.getLogs({ fromBlock: 500n, toBlock: 500n, addresses, topics0: topics });

    // Seven topic selectors leave room for 993 addresses in the first query, not
    // 1,000 + 7 selectors, which OrdoFi rejects.
    expect(request).toHaveBeenCalledTimes(2);
    expect(filterOf(request, 1)).toMatchObject({
      address: addresses.slice(0, MAX_LOG_ADDRESSES_PER_QUERY - topics.length),
      topics: [topics],
    });
  });

  it("bounds concurrent address-group calls instead of bursting all groups at once", async () => {
    let active = 0;
    let peak = 0;
    const request = vi.fn().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return [];
    });
    const source = new RpcLogSource({} as unknown as PublicClient, 100n, {
      request,
    } as unknown as RpcPool);
    const addresses = Array.from(
      { length: MAX_LOG_ADDRESSES_PER_QUERY * 3 },
      (_, index) => address(index + 1),
    );

    await source.getLogs({ fromBlock: 500n, toBlock: 500n, addresses });

    expect(request).toHaveBeenCalledTimes(3);
    expect(peak).toBe(MAX_CONCURRENT_LOG_ADDRESS_QUERIES);
  });
});
