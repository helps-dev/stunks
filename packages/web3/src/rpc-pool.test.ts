import { describe, expect, it, vi } from "vitest";
import { RpcPool } from "./rpc-pool.js";
import { AllEndpointsFailedError, RpcCallError, isRetryable } from "./errors.js";
import { AdaptiveLogWindow, splitBlockRange } from "./log-range.js";

/**
 * The behaviours under test here are not hypothetical. Each one was observed on a
 * Robinhood Chain endpoint during the Phase 0 audit.
 */

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const htmlResponse = (status = 403): Response =>
  new Response("<!DOCTYPE html><html><head><title>Just a moment...</title>", {
    status,
    headers: { "content-type": "text/html" },
  });

const noSleep = () => Promise.resolve();

describe("non-JSON responses", () => {
  it("treats an HTML throttle page as a failure, not as an answer", async () => {
    // This is the important one. A throttled endpoint returned HTML with a 403.
    // Parsing that as a result would make "no code at this address" and "no logs in
    // this range" indistinguishable from the truth.
    // A fresh Response per call: a body can only be consumed once.
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(htmlResponse(403)));
    const pool = new RpcPool(["https://throttled.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });

    const failure = await pool.request("eth_getCode").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AllEndpointsFailedError);
    expect((failure as AllEndpointsFailedError).failures[0]?.kind).toBe(
      "NON_JSON_RESPONSE",
    );
  });

  it("fails over to a healthy endpoint when the first returns HTML", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse(403))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1237" }));

    const pool = new RpcPool(["https://throttled.example", "https://healthy.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });

    await expect(pool.request<string>("eth_chainId")).resolves.toBe("0x1237");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("classifies a 429 as rate limiting even when the body is HTML", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(429));
    const pool = new RpcPool(["https://limited.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });
    const failure = await pool
      .request("eth_chainId")
      .catch((e: AllEndpointsFailedError) => e);
    expect((failure as AllEndpointsFailedError).failures[0]?.kind).toBe("RATE_LIMITED");
  });
});

describe("log range errors", () => {
  it("does not retry a too-wide range elsewhere — the caller must narrow it", async () => {
    // The real message observed was misleading: it claimed a 10,000-block limit while
    // rejecting 500. Retrying another endpoint wastes budget and hides the real fix.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: 35,
          message: "ranges over 10000 blocks are not supported on free plan",
        },
      }),
    );
    const pool = new RpcPool(["https://a.example", "https://b.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    const failure = await pool.request("eth_getLogs").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RpcCallError);
    expect((failure as RpcCallError).kind).toBe("LOG_RANGE_TOO_WIDE");
    // One call only: no failover, no retry.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not count a range rejection against endpoint health", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: 35, message: "ranges over 10000 blocks are not supported" },
      }),
    );
    const pool = new RpcPool(["https://archive.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await pool.request("eth_getLogs").catch(() => undefined);
    // A perfectly good archive node must not be demoted for the caller's mistake.
    expect(pool.stats()[0]?.consecutiveFailures).toBe(0);
    expect(pool.stats()[0]?.healthy).toBe(true);
  });

  it("marks a revert as non-retryable", () => {
    expect(isRetryable("RPC_ERROR")).toBe(false);
    expect(isRetryable("LOG_RANGE_TOO_WIDE")).toBe(false);
    expect(isRetryable("NON_JSON_RESPONSE")).toBe(true);
    expect(isRetryable("RATE_LIMITED")).toBe(true);
  });
});

describe("health tracking", () => {
  it("puts an endpoint in cooldown after repeated failures", async () => {
    let now = 1_000;
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(htmlResponse(403)));
    const pool = new RpcPool(["https://bad.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 3,
      failureThreshold: 3,
      cooldownMs: 5_000,
      now: () => now,
      sleep: noSleep,
    });

    await pool.request("eth_chainId").catch(() => undefined);
    expect(pool.stats()[0]?.healthy).toBe(false);

    now += 6_000;
    expect(pool.stats()[0]?.healthy).toBe(true);
  });

  it("still tries a cooling endpoint when nothing else is available", async () => {
    // A degraded answer beats no answer.
    let now = 1_000;
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? htmlResponse(403)
          : jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }),
      );
    });

    const pool = new RpcPool(["https://only.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 2,
      failureThreshold: 1,
      cooldownMs: 60_000,
      now: () => now,
      sleep: noSleep,
    });

    await expect(pool.request<string>("eth_chainId")).resolves.toBe("0x1");
    now += 1;
    await expect(pool.request<string>("eth_chainId")).resolves.toBe("0x1");
  });

  it("records latency so the fastest strategy has something to sort on", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" })),
      );
    let now = 0;
    const pool = new RpcPool(["https://a.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => (now += 5),
      sleep: noSleep,
    });
    await pool.request("eth_chainId");
    expect(pool.stats()[0]?.avgLatencyMs).not.toBeNull();
  });
});

describe("per-endpoint pacing", () => {
  it("waits between calls to an endpoint that only tolerates a low rate", async () => {
    const sleeps: number[] = [];
    let now = 0;
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" })),
      );

    const pool = new RpcPool([{ url: "https://slow.example", minIntervalMs: 600 }], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await pool.request("eth_chainId");
    await pool.request("eth_chainId");
    // The second call must have been paced.
    expect(sleeps.some((ms) => ms > 0)).toBe(true);
  });
});

describe("block range splitting", () => {
  it("splits into windows no wider than the limit", () => {
    const windows = splitBlockRange(1_000n, 1_250n, 100n);
    expect(windows).toHaveLength(3);
    expect(windows[0]).toEqual({ fromBlock: 1_000n, toBlock: 1_099n });
    expect(windows[2]).toEqual({ fromBlock: 1_200n, toBlock: 1_250n });
  });

  it("covers the range exactly, with no gaps or overlaps", () => {
    const windows = splitBlockRange(0n, 999n, 100n);
    expect(windows[0]?.fromBlock).toBe(0n);
    expect(windows.at(-1)?.toBlock).toBe(999n);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]?.fromBlock).toBe((windows[i - 1]?.toBlock ?? 0n) + 1n);
    }
  });

  it("handles a single-block range", () => {
    expect(splitBlockRange(5n, 5n, 100n)).toEqual([{ fromBlock: 5n, toBlock: 5n }]);
  });

  it("throws on an inverted range rather than scanning nothing", () => {
    // A silently empty scan is indistinguishable from "no events happened".
    expect(() => splitBlockRange(10n, 5n)).toThrow(/inverted/i);
  });
});

describe("adaptive log window", () => {
  it("halves on rejection and never goes below the floor", () => {
    const window = new AdaptiveLogWindow(100n, 10n, 10_000n);
    expect(window.onRejected()).toBe(50n);
    expect(window.onRejected()).toBe(25n);
    expect(window.onRejected()).toBe(12n);
    expect(window.onRejected()).toBe(10n);
    expect(window.onRejected()).toBe(10n);
  });

  it("grows on success but respects the ceiling", () => {
    const window = new AdaptiveLogWindow(100n, 10n, 130n);
    expect(window.onSuccess()).toBe(126n);
    expect(window.onSuccess()).toBe(130n);
    expect(window.onSuccess()).toBe(130n);
  });
});
