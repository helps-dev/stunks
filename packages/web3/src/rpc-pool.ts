import {
  AllEndpointsFailedError,
  BatchNotSupportedError,
  RpcCallError,
  type RpcFailureKind,
  classifyRpcErrorMessage,
  isRetryable,
  parseAllowedBatchSize,
} from "./errors.js";

/**
 * A JSON-RPC pool built for the endpoint behaviour actually observed on Robinhood
 * Chain, not for an idealised RPC:
 *
 *  - one endpoint answers with an HTML 403 page when throttled, so every response
 *    is content-checked before it is trusted
 *  - one endpoint caps eth_getLogs at a few hundred blocks and reports it with a
 *    misleading message, so that failure is classified separately and is NOT
 *    retried elsewhere (the caller has to narrow the range instead)
 *  - the official endpoint may be unreachable from a given network entirely
 *  - public endpoints throttle around 2 req/s, so per-endpoint pacing is built in
 */

export type SelectionStrategy = "ordered" | "fastest";

export interface EndpointConfig {
  readonly url: string;
  /** Minimum gap between requests to this endpoint. Use for ~2 req/s endpoints. */
  readonly minIntervalMs?: number;
}

export interface RpcPoolOptions {
  /**
   * `ordered` walks the list in configured order — deterministic, preferred for
   * the indexer where reproducibility beats latency.
   * `fastest` prefers the lowest observed latency — preferred for user-facing reads.
   */
  readonly strategy?: SelectionStrategy;
  readonly timeoutMs?: number;
  /** Attempts per endpoint before moving to the next one. */
  readonly attemptsPerEndpoint?: number;
  readonly backoffBaseMs?: number;
  /** Consecutive failures before an endpoint is put in cooldown. */
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** One call inside a JSON-RPC batch. See `RpcPool.requestBatch`. */
export interface RpcBatchCall {
  readonly method: string;
  readonly params?: readonly unknown[];
}

/** One envelope from a JSON-RPC batch response. */
interface BatchEntry {
  id?: number;
  error?: { code?: number; message?: string };
  result?: unknown;
}

export interface EndpointHealth {
  readonly url: string;
  readonly healthy: boolean;
  readonly consecutiveFailures: number;
  readonly totalRequests: number;
  readonly totalFailures: number;
  readonly lastLatencyMs: number | null;
  readonly avgLatencyMs: number | null;
  readonly cooldownUntil: number | null;
  readonly lastErrorKind: string | null;
}

interface MutableHealth {
  url: string;
  minIntervalMs: number;
  consecutiveFailures: number;
  totalRequests: number;
  totalFailures: number;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
  cooldownUntil: number | null;
  lastErrorKind: string | null;
  nextAllowedAt: number;
  /**
   * Largest JSON-RPC batch this endpoint has proven it will serve, discovered at
   * runtime. `null` means nothing has been rejected yet.
   *
   * Discovered rather than configured, for the same reason the log window is: these
   * endpoints misreport their own limits, and the free-plan caps differ per provider.
   */
  maxBatchSize: number | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Classify a JSON-RPC error, using the HTTP status only when the message itself says
 * nothing recognisable.
 *
 * The message wins because it is the actionable part: "ranges over 10000 blocks are
 * not supported" tells the caller to narrow, where the accompanying HTTP 400 does not.
 * The status is still the fallback so that an unhelpful error delivered with a 429
 * stays retryable rather than becoming a permanent RPC_ERROR.
 */
function classifyWithStatus(
  message: string,
  status: number,
  ok: boolean,
): RpcFailureKind {
  const kind = classifyRpcErrorMessage(message);
  if (ok || kind !== "RPC_ERROR") return kind;
  return status === 429 ? "RATE_LIMITED" : "HTTP_ERROR";
}

export class RpcPool {
  private readonly endpoints: MutableHealth[];
  private readonly strategy: SelectionStrategy;
  private readonly timeoutMs: number;
  private readonly attemptsPerEndpoint: number;
  private readonly backoffBaseMs: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private requestId = 0;

  constructor(
    endpoints: readonly (string | EndpointConfig)[],
    options: RpcPoolOptions = {},
  ) {
    if (endpoints.length === 0) {
      throw new Error("RpcPool requires at least one endpoint");
    }
    this.endpoints = endpoints.map((entry) => {
      const config = typeof entry === "string" ? { url: entry } : entry;
      return {
        url: config.url,
        minIntervalMs: config.minIntervalMs ?? 0,
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
        lastLatencyMs: null,
        avgLatencyMs: null,
        cooldownUntil: null,
        lastErrorKind: null,
        nextAllowedAt: 0,
        maxBatchSize: null,
      };
    });
    this.strategy = options.strategy ?? "ordered";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.attemptsPerEndpoint = options.attemptsPerEndpoint ?? 2;
    this.backoffBaseMs = options.backoffBaseMs ?? 250;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Health snapshot for the indexer health endpoint and admin dashboard. */
  stats(): readonly EndpointHealth[] {
    const now = this.now();
    return this.endpoints.map((endpoint) => ({
      url: endpoint.url,
      healthy: endpoint.cooldownUntil === null || endpoint.cooldownUntil <= now,
      consecutiveFailures: endpoint.consecutiveFailures,
      totalRequests: endpoint.totalRequests,
      totalFailures: endpoint.totalFailures,
      lastLatencyMs: endpoint.lastLatencyMs,
      avgLatencyMs: endpoint.avgLatencyMs,
      cooldownUntil: endpoint.cooldownUntil,
      lastErrorKind: endpoint.lastErrorKind,
    }));
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const failures: RpcCallError[] = [];

    for (const endpoint of this.selectOrder()) {
      for (let attempt = 0; attempt < this.attemptsPerEndpoint; attempt++) {
        try {
          return await this.callEndpoint<T>(endpoint, method, params);
        } catch (error) {
          const failure =
            error instanceof RpcCallError
              ? error
              : new RpcCallError({
                  kind: "NETWORK",
                  endpoint: endpoint.url,
                  method,
                  message: error instanceof Error ? error.message : String(error),
                  cause: error,
                });
          failures.push(failure);
          this.recordFailure(endpoint, failure);

          // A revert, a bad param, or a too-wide log range will fail the same way
          // everywhere. Surface it immediately instead of hammering the pool.
          if (!isRetryable(failure.kind)) throw failure;

          const isLastAttempt = attempt === this.attemptsPerEndpoint - 1;
          if (!isLastAttempt) {
            await this.sleep(this.backoffBaseMs * 2 ** attempt);
          }
        }
      }
    }

    throw new AllEndpointsFailedError(method, failures);
  }

  private selectOrder(): MutableHealth[] {
    const now = this.now();
    const healthy = this.endpoints.filter(
      (endpoint) => endpoint.cooldownUntil === null || endpoint.cooldownUntil <= now,
    );
    const cooling = this.endpoints.filter(
      (endpoint) => endpoint.cooldownUntil !== null && endpoint.cooldownUntil > now,
    );

    const preferred =
      this.strategy === "fastest"
        ? [...healthy].sort(
            (a, b) => (a.avgLatencyMs ?? Infinity) - (b.avgLatencyMs ?? Infinity),
          )
        : healthy;

    // Cooling endpoints stay last rather than being removed: if every endpoint is
    // in cooldown, a degraded answer still beats no answer at all.
    return [...preferred, ...cooling];
  }

  private async callEndpoint<T>(
    endpoint: MutableHealth,
    method: string,
    params: readonly unknown[],
  ): Promise<T> {
    await this.respectPacing(endpoint);

    const startedAt = this.now();
    endpoint.totalRequests += 1;
    this.requestId += 1;

    const { payload, status, ok } = await this.postRpc(
      endpoint,
      { jsonrpc: "2.0", id: this.requestId, method, params },
      method,
    );

    const envelope = payload as {
      error?: { code?: number; message?: string };
      result?: T;
    };

    if (envelope.error) {
      const message = envelope.error.message ?? "unknown RPC error";
      throw new RpcCallError({
        kind: classifyWithStatus(message, status, ok),
        endpoint: endpoint.url,
        method,
        message,
        ...(envelope.error.code !== undefined ? { rpcCode: envelope.error.code } : {}),
        ...(ok ? {} : { statusCode: status }),
      });
    }

    // A null result for a block lookup is a JSON-RPC *success*, so nothing above
    // catches it — yet it is exactly how a lagging endpoint reports "I have not
    // indexed that block yet". viem then turns the null into BlockNotFoundError and
    // the caller never learns another endpoint could have answered.
    //
    // Observed on Robinhood Chain near head: one endpoint serves eth_blockNumber
    // while another, a few blocks behind, returns null for that same block.
    //
    // Only block lookups are treated this way. A null from, say,
    // eth_getTransactionReceipt legitimately means "pending" and must be returned.
    if (
      envelope.result === null &&
      (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash")
    ) {
      throw new RpcCallError({
        kind: "BLOCK_UNAVAILABLE",
        endpoint: endpoint.url,
        method,
        message: `endpoint returned no block for ${JSON.stringify(params[0] ?? null)}`,
      });
    }

    this.recordSuccess(endpoint, this.now() - startedAt);
    return envelope.result as T;
  }

  /**
   * One HTTP POST, with every failure mode this pool has actually met mapped onto an
   * RpcCallError. Shared by the single and batched paths, because the invariant that
   * matters most here — a throttled endpoint answers with HTML, and HTML is a
   * transport failure rather than a chain answer — must not drift between them.
   */
  private async postRpc(
    endpoint: MutableHealth,
    body: unknown,
    method: string,
  ): Promise<{ payload: unknown; status: number; ok: boolean }> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new RpcCallError({
        kind: isTimeout ? "TIMEOUT" : "NETWORK",
        endpoint: endpoint.url,
        method,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }

    const bodyText = await response.text();

    // The critical check. A throttled endpoint returns HTML; parsing that as an
    // answer is how "no code at this address" and "no logs in this range" become
    // silent lies.
    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new RpcCallError({
        kind: response.status === 429 ? "RATE_LIMITED" : "NON_JSON_RESPONSE",
        endpoint: endpoint.url,
        method,
        statusCode: response.status,
        message: `expected JSON-RPC, got ${response.status} ${
          response.headers.get("content-type") ?? "unknown content-type"
        }: ${bodyText.slice(0, 80).replace(/\s+/g, " ")}`,
      });
    }

    /**
     * A non-2xx status is NOT allowed to hide the reason the endpoint gave.
     *
     * This ordering was a silent, expensive bug. dRPC rejects an over-wide
     * eth_getLogs with HTTP 400 and a JSON-RPC error that names the problem
     * ("ranges over 10000 blocks are not supported"), and it rejects an oversized
     * batch with HTTP 500 and a complete array of envelopes carrying code 31.
     * Throwing on the status first flattened both into an opaque HTTP_ERROR, which is
     * retryable but carries no instruction — so AdaptiveLogWindow never once narrowed
     * across every run of this indexer, the window only ever grew, and both streams
     * eventually locked onto a range no endpoint would serve and stopped for hours.
     *
     * The body still has to parse as JSON to be trusted, so a throttled endpoint's
     * HTML page is classified exactly as before.
     */
    const carriesError =
      Array.isArray(payload)
        ? payload.some((entry) => (entry as BatchEntry | null)?.error !== undefined)
        : typeof payload === "object" &&
          payload !== null &&
          (payload as BatchEntry).error !== undefined;

    if (!response.ok && !carriesError) {
      throw new RpcCallError({
        kind: response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR",
        endpoint: endpoint.url,
        method,
        statusCode: response.status,
        message: `HTTP ${response.status}`,
      });
    }

    if (typeof payload !== "object" || payload === null) {
      throw new RpcCallError({
        kind: "NON_JSON_RESPONSE",
        endpoint: endpoint.url,
        method,
        message: "JSON-RPC response was not an object",
      });
    }

    return { payload, status: response.status, ok: response.ok };
  }

  /**
   * Many calls in a single HTTP POST, with the same failover as `request`.
   *
   * This exists for one measured problem: the indexer needs a timestamp for every
   * block a trade appears in, `eth_getBlockByNumber` is not something multicall can
   * batch, and the curve stream's window reaches thousands of blocks. Issued one per
   * block, that is thousands of requests against endpoints that serve a few per
   * second, and it was observed saturating the pool until the stream stopped
   * advancing entirely. Batched, the same work is a handful of POSTs.
   *
   * Batch support was confirmed against both endpoints before this was written:
   * three eth_getBlockByNumber calls in one POST returned three responses.
   *
   * A batch succeeds or fails as a unit. Per-item recovery would mean deciding which
   * half of a window was written, and a whole-batch retry on another endpoint is both
   * simpler and cheap, since these are confirmed blocks that any healthy archive node
   * can serve.
   */
  async requestBatch<T>(calls: readonly RpcBatchCall[]): Promise<readonly T[]> {
    if (calls.length === 0) return [];

    const label = `${calls[0]?.method ?? "batch"} (batch of ${calls.length})`;
    const failures: RpcCallError[] = [];

    const capable = this.selectOrder().filter(
      (endpoint) => endpoint.maxBatchSize === null || endpoint.maxBatchSize >= calls.length,
    );
    if (capable.length === 0) {
      throw new BatchNotSupportedError(
        calls.length,
        `No endpoint will serve a batch of ${calls.length}: ` +
          this.endpoints
            .map((endpoint) => `${endpoint.url} allows ${endpoint.maxBatchSize ?? "?"}`)
            .join(", "),
      );
    }

    for (const endpoint of capable) {
      for (let attempt = 0; attempt < this.attemptsPerEndpoint; attempt++) {
        try {
          return await this.callEndpointBatch<T>(endpoint, calls, label);
        } catch (error) {
          const failure =
            error instanceof RpcCallError
              ? error
              : new RpcCallError({
                  kind: "NETWORK",
                  endpoint: endpoint.url,
                  method: label,
                  message: error instanceof Error ? error.message : String(error),
                  cause: error,
                });
          failures.push(failure);
          this.recordFailure(endpoint, failure);

          if (!isRetryable(failure.kind)) throw failure;

          // A plan limit will reject the same size every time, so remember it and move
          // on instead of spending the remaining attempts learning it again.
          if (failure.kind === "BATCH_TOO_LARGE") {
            const allowed = parseAllowedBatchSize(failure.message);
            endpoint.maxBatchSize = Math.min(allowed ?? calls.length - 1, calls.length - 1);
            break;
          }

          const isLastAttempt = attempt === this.attemptsPerEndpoint - 1;
          if (!isLastAttempt) {
            await this.sleep(this.backoffBaseMs * 2 ** attempt);
          }
        }
      }
    }

    throw new AllEndpointsFailedError(label, failures);
  }

  private async callEndpointBatch<T>(
    endpoint: MutableHealth,
    calls: readonly RpcBatchCall[],
    label: string,
  ): Promise<readonly T[]> {
    await this.respectPacing(endpoint);

    const startedAt = this.now();
    endpoint.totalRequests += 1;
    const baseId = this.requestId + 1;
    this.requestId += calls.length;

    const { payload, status, ok } = await this.postRpc(
      endpoint,
      calls.map((call, index) => ({
        jsonrpc: "2.0",
        id: baseId + index,
        method: call.method,
        params: call.params ?? [],
      })),
      label,
    );

    if (!Array.isArray(payload)) {
      // An endpoint that does not implement batching answers with a single envelope,
      // which would otherwise be silently read as the first call's result.
      throw new RpcCallError({
        kind: "NON_JSON_RESPONSE",
        endpoint: endpoint.url,
        method: label,
        message: "expected a JSON-RPC batch array",
      });
    }

    // The spec allows a server to answer a batch in any order, so results are matched
    // by id rather than by position.
    const byId = new Map<number, BatchEntry>();
    for (const entry of payload as BatchEntry[]) {
      if (typeof entry.id === "number") byId.set(entry.id, entry);
    }

    const results: T[] = [];
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index]!;
      const entry = byId.get(baseId + index);
      if (entry === undefined) {
        throw new RpcCallError({
          kind: "NON_JSON_RESPONSE",
          endpoint: endpoint.url,
          method: label,
          message: `batch response missing id ${baseId + index} for ${call.method}`,
        });
      }
      if (entry.error) {
        const message = entry.error.message ?? "unknown RPC error";
        throw new RpcCallError({
          kind: classifyWithStatus(message, status, ok),
          endpoint: endpoint.url,
          method: call.method,
          message,
          ...(entry.error.code !== undefined ? { rpcCode: entry.error.code } : {}),
          ...(ok ? {} : { statusCode: status }),
        });
      }
      // Same reasoning as the single-call path: a null block is a lagging endpoint
      // reporting a gap through a JSON-RPC success, so it has to fail over.
      if (
        entry.result === null &&
        (call.method === "eth_getBlockByNumber" || call.method === "eth_getBlockByHash")
      ) {
        throw new RpcCallError({
          kind: "BLOCK_UNAVAILABLE",
          endpoint: endpoint.url,
          method: call.method,
          message: `endpoint returned no block for ${JSON.stringify(
            call.params?.[0] ?? null,
          )}`,
        });
      }
      results.push(entry.result as T);
    }

    this.recordSuccess(endpoint, this.now() - startedAt);
    return results;
  }

  private async respectPacing(endpoint: MutableHealth): Promise<void> {
    if (endpoint.minIntervalMs <= 0) return;
    const wait = endpoint.nextAllowedAt - this.now();
    if (wait > 0) await this.sleep(wait);
    endpoint.nextAllowedAt = this.now() + endpoint.minIntervalMs;
  }

  private recordSuccess(endpoint: MutableHealth, latencyMs: number): void {
    endpoint.consecutiveFailures = 0;
    endpoint.cooldownUntil = null;
    endpoint.lastErrorKind = null;
    endpoint.lastLatencyMs = latencyMs;
    // EWMA, weighted toward recent behaviour so a recovered endpoint is promoted
    // reasonably quickly under the `fastest` strategy.
    endpoint.avgLatencyMs =
      endpoint.avgLatencyMs === null
        ? latencyMs
        : endpoint.avgLatencyMs * 0.7 + latencyMs * 0.3;
  }

  private recordFailure(endpoint: MutableHealth, failure: RpcCallError): void {
    endpoint.totalFailures += 1;
    endpoint.lastErrorKind = failure.kind;
    // A too-wide log range is the caller's problem, not the endpoint's. Counting
    // it against health would demote a perfectly good archive node. A batch-size
    // rejection is a billing plan, not ill health, and the same applies.
    if (failure.kind === "LOG_RANGE_TOO_WIDE" || failure.kind === "BATCH_TOO_LARGE") return;
    endpoint.consecutiveFailures += 1;
    if (endpoint.consecutiveFailures >= this.failureThreshold) {
      endpoint.cooldownUntil = this.now() + this.cooldownMs;
    }
  }
}
