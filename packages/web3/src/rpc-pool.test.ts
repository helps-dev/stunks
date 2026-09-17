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
    expect(isRetryable("DETERMINISTIC_ERROR")).toBe(false);
    expect(isRetryable("LOG_RANGE_TOO_WIDE")).toBe(false);
    // The fallback bucket is retryable: "unrecognised" must not imply "everyone
    // would answer the same".
    expect(isRetryable("RPC_ERROR")).toBe(true);
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

describe("batch splitting", () => {
  /**
   * The failure this replaces cost more than the batching saved.
   *
   * dRPC's free plan takes 3 calls per POST; OrdoFi takes far more but was refusing
   * everything. A batch of 23 therefore had one capable endpoint, and when it failed
   * the pool raised BatchNotSupportedError — whose only answer, in the caller, was one
   * request per item. Measured 2026-09-17: nine of ten curve windows fell back to
   * roughly 25 sequential POSTs, which dominated the tick.
   */
  const call = (n: number) => ({ method: "eth_getBlockByNumber", params: [n] });

  function poolWith(maxBatchSizes: Record<string, number>, onBatch: (n: number) => void) {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number }[];
      onBatch(body.length);
      return Promise.resolve(
        jsonResponse(
          body.map((entry) => ({ jsonrpc: "2.0", id: entry.id, result: "0x1" })),
        ),
      );
    });
    const pool = new RpcPool(Object.keys(maxBatchSizes), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });
    // Stand in for limits the pool would otherwise learn from a rejection.
    for (const endpoint of pool.stats()) {
      const target = (
        pool as unknown as { endpoints: { url: string; maxBatchSize: number | null }[] }
      ).endpoints.find((e) => e.url === endpoint.url);
      if (target) target.maxBatchSize = maxBatchSizes[endpoint.url]!;
    }
    return pool;
  }

  it("splits into chunks the pool can serve instead of refusing", async () => {
    const sizes: number[] = [];
    const pool = poolWith({ "https://small.example": 3 }, (n) => sizes.push(n));

    const results = await pool.requestBatch<string>(
      Array.from({ length: 8 }, (_, i) => call(i)),
    );

    expect(results).toHaveLength(8);
    // 8 calls at 3 per POST: 3 + 3 + 2, not one POST of 8 and not 8 POSTs of one.
    expect(sizes).toEqual([3, 3, 2]);
  });

  it("preserves the order of results across chunks", async () => {
    const pool = new RpcPool(["https://small.example"], {
      fetchImpl: vi.fn().mockImplementation((_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { id: number; params: number[] }[];
        return Promise.resolve(
          jsonResponse(
            body.map((e) => ({ jsonrpc: "2.0", id: e.id, result: `v${e.params[0]}` })),
          ),
        );
      }) as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });
    (
      pool as unknown as { endpoints: { maxBatchSize: number | null }[] }
    ).endpoints[0]!.maxBatchSize = 2;

    const results = await pool.requestBatch<string>(
      Array.from({ length: 5 }, (_, i) => call(i)),
    );
    expect(results).toEqual(["v0", "v1", "v2", "v3", "v4"]);
  });

  it("chunks onto a smaller endpoint after the capable one fails", async () => {
    // The exact shape observed on 2026-09-17: dRPC's limit is known (3), OrdoFi's is
    // not, so nothing is proven about the pool and the full batch is attempted. Only
    // OrdoFi qualifies for it — and OrdoFi is the one failing. Without the fallback,
    // dRPC never gets asked and the caller drops to one request per item.
    const sizes: number[] = [];
    const fetchImpl = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number }[];
      if (url.includes("unknown")) {
        return Promise.resolve(
          jsonResponse(
            body.map((e) => ({
              jsonrpc: "2.0",
              id: e.id,
              error: { code: -32000, message: "the network is busy, please try again" },
            })),
          ),
        );
      }
      sizes.push(body.length);
      return Promise.resolve(
        jsonResponse(body.map((e) => ({ jsonrpc: "2.0", id: e.id, result: "0x1" }))),
      );
    });

    const pool = new RpcPool(["https://unknown.example", "https://small.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });
    const endpoints = (
      pool as unknown as { endpoints: { url: string; maxBatchSize: number | null }[] }
    ).endpoints;
    endpoints.find((e) => e.url.includes("small"))!.maxBatchSize = 3;
    // The other stays null: not yet declared.

    const results = await pool.requestBatch<string>(
      Array.from({ length: 7 }, (_, i) => call(i)),
    );

    expect(results).toHaveLength(7);
    // Served by the small endpoint in chunks, not abandoned.
    expect(sizes).toEqual([3, 3, 1]);
  });

  it("sends one POST when an endpoint will take the whole batch", async () => {
    const sizes: number[] = [];
    const pool = poolWith({ "https://big.example": 100 }, (n) => sizes.push(n));

    await pool.requestBatch<string>(Array.from({ length: 8 }, (_, i) => call(i)));
    expect(sizes).toEqual([8]);
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

  it("grows on success but respects the configured maximum", () => {
    const window = new AdaptiveLogWindow(100n, 10n, 130n);
    expect(window.onSuccess()).toBe(126n);
    expect(window.onSuccess()).toBe(130n);
    expect(window.onSuccess()).toBe(130n);
  });

  /**
   * The oscillation these tests exist to stop.
   *
   * dRPC's free plan rejects anything over 100 blocks while its message claims the
   * limit is 10,000. Pure additive-increase relearned that every cycle — grow to 126,
   * rejected, halve to 63, climb back — spending roughly one tick in four on a limit
   * that had not moved, and averaging a window near 85 instead of 100.
   */
  it("searches between the best known-good span and the bound, not from zero", () => {
    const window = new AdaptiveLogWindow(100n, 10n, 10_000n);

    // Overshoot once, exactly as it did against dRPC.
    expect(window.onSuccess()).toBe(126n);
    // 100 is known to work, so a rejection at 126 does not throw that away and halve
    // to 63 — it steps to the midpoint. Discarding proven capacity was most of the
    // cost of the old behaviour.
    expect(window.onRejected()).toBe(113n);
    expect(window.knownCeiling()).toBe(126n);
  });

  it("converges on a hard limit and then stops moving", () => {
    // A provider whose real ceiling is exactly 100, like dRPC's free plan.
    const REAL_LIMIT = 100n;
    const window = new AdaptiveLogWindow(100n, 10n, 10_000n);

    let rejections = 0;
    for (let i = 0; i < 60; i++) {
      if (window.current() > REAL_LIMIT) {
        window.onRejected();
        rejections += 1;
      } else {
        window.onSuccess();
      }
    }

    // Bracketed quickly rather than cycling forever.
    expect(rejections).toBeLessThanOrEqual(8);
    expect(window.settled()).toBe(true);
    // And settled ON the limit, not below it.
    expect(window.current()).toBe(REAL_LIMIT);

    // Stable from here: no further rejection is provoked.
    const before = rejections;
    for (let i = 0; i < 100; i++) {
      if (window.current() > REAL_LIMIT) {
        window.onRejected();
        rejections += 1;
      } else {
        window.onSuccess();
      }
    }
    expect(rejections).toBe(before);
  });

  it("believes the lowest rejection it has seen", () => {
    const window = new AdaptiveLogWindow(200n, 10n, 10_000n);
    window.onRejected();
    expect(window.knownCeiling()).toBe(200n);

    const w2 = new AdaptiveLogWindow(80n, 10n, 10_000n);
    w2.onRejected();
    expect(w2.knownCeiling()).toBe(80n);
  });

  it("re-probes occasionally so a raised plan limit is rediscovered", () => {
    const window = new AdaptiveLogWindow(100n, 10n, 10_000n);
    window.onSuccess();
    window.onRejected();
    // Settle the search first.
    for (let i = 0; i < 20; i++) window.onSuccess();
    expect(window.settled()).toBe(true);
    const settledSpan = window.current();

    // Eventually it spends one tick asking again above the settled span. A limit is
    // a plan setting, so a one-way ratchet would strand the indexer on an old plan.
    let probed = false;
    for (let i = 0; i < 400 && !probed; i++) {
      if (window.onSuccess() > settledSpan) probed = true;
    }
    expect(probed).toBe(true);
  });

  it("forgets a stale ceiling once a span at that size succeeds", () => {
    const window = new AdaptiveLogWindow(100n, 10n, 10_000n);
    window.onSuccess();
    window.onRejected();
    expect(window.knownCeiling()).toBe(126n);
    for (let i = 0; i < 20; i++) window.onSuccess();

    const settledSpan = window.current();
    let probed = false;
    for (let i = 0; i < 400 && !probed; i++) {
      if (window.onSuccess() > settledSpan) probed = true;
    }
    expect(probed).toBe(true);

    // The probe was not rejected, so the bound is dropped and growth resumes.
    window.onSuccess();
    expect(window.knownCeiling()).toBeNull();
    expect(window.settled()).toBe(false);
  });
});

describe("provider head disagreement", () => {
  it("fails over when an endpoint has not indexed a block another provider reported", async () => {
    // Observed near chain head: endpoint A supplies eth_blockNumber, but endpoint B
    // selected for the later read is a few blocks behind. This must retry/fail over,
    // not be treated like an invalid block parameter or a bad block.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: 'Block at number "63921610" could not be found.',
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 2, result: "0xabc" }));

    const pool = new RpcPool(["https://behind.example", "https://current.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });

    await expect(
      pool.request<string>("eth_getBlockByNumber", ["0x3", false]),
    ).resolves.toBe("0xabc");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(pool.stats()[0]).toMatchObject({
      consecutiveFailures: 1,
      lastErrorKind: "BLOCK_UNAVAILABLE",
    });
  });

  it("keeps the retry contract for the observed missing-block message", () => {
    expect(
      isRetryable(
        // Classification is exercised via pool above; this guards the retry contract.
        "BLOCK_UNAVAILABLE",
      ),
    ).toBe(true);
    expect(isRetryable("DETERMINISTIC_ERROR")).toBe(false);
  });

  it("fails over when a lagging endpoint returns a null block instead of an error", async () => {
    // The case actually seen in the indexer logs. A null result is a JSON-RPC
    // SUCCESS, so without this the pool returns null, viem raises
    // BlockNotFoundError, and no failover is ever attempted.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: null }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { number: "0x3", hash: "0xfeed" },
        }),
      );

    const pool = new RpcPool(["https://behind.example", "https://current.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });

    await expect(
      pool.request<{ hash: string }>("eth_getBlockByNumber", ["0x3", false]),
    ).resolves.toEqual({ number: "0x3", hash: "0xfeed" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(pool.stats()[0]?.lastErrorKind).toBe("BLOCK_UNAVAILABLE");
  });

  it("still returns a null receipt, because pending is a real answer", async () => {
    // Only block lookups get the null-means-unavailable treatment. A pending
    // transaction legitimately has no receipt and must not trigger failover.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: null }));

    const pool = new RpcPool(["https://a.example", "https://b.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });

    await expect(
      pool.request("eth_getTransactionReceipt", ["0xdead"]),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("overloaded upstream log providers", () => {
  it.each([
    "the network is busy, please try again in a moment",
    "eth_getLogs: block 63961375 alone returns more logs than the upstream will serve. Add an address or topic filter.",
    // The one that froze the curve stream for seven hours on 2026-09-17. OrdoFi is
    // itself a proxy, so this reports ITS upstreams as unavailable — the textbook
    // reason to ask a different endpoint.
    "all RPC upstreams refused the request — fetch failed",
  ])(
    "fails over instead of shrinking an inherently unsupportable query: %s",
    async (message) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message },
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 2, result: [] }));

      const pool = new RpcPool(
        ["https://overloaded.example", "https://healthy.example"],
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          attemptsPerEndpoint: 1,
          sleep: noSleep,
        },
      );

      await expect(pool.request<readonly unknown[]>("eth_getLogs", [])).resolves.toEqual(
        [],
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(pool.stats()[0]?.lastErrorKind).toBe("UPSTREAM_UNAVAILABLE");
    },
  );

  /**
   * The class of bug, not just the instance.
   *
   * Adding a pattern fixes one string. The reason one string could freeze a stream is
   * that the fallback bucket asserted "every endpoint will answer this identically",
   * which for a pool of third-party providers is usually false. These two tests pin
   * the inverted default so the next unrecognised provider message costs a retry
   * rather than an outage.
   */
  it("tries the next endpoint on an error it does not recognise", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "sharding backend wedged, code 7" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 2, result: [] }));

    const pool = new RpcPool(["https://weird.example", "https://healthy.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });

    await expect(pool.request<readonly unknown[]>("eth_getLogs", [])).resolves.toEqual(
      [],
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(pool.stats()[0]?.lastErrorKind).toBe("RPC_ERROR");
  });

  it("does not spend the pool on an error that is genuinely the caller's", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "execution reverted" },
      }),
    );

    const pool = new RpcPool(["https://a.example", "https://b.example"], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attemptsPerEndpoint: 1,
      sleep: noSleep,
    });

    const failure = await pool.request("eth_call", []).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RpcCallError);
    expect((failure as RpcCallError).kind).toBe("DETERMINISTIC_ERROR");
    // One endpoint, not two: a revert is the same answer everywhere.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
