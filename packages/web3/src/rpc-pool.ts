import {
  AllEndpointsFailedError,
  RpcCallError,
  classifyRpcErrorMessage,
  isRetryable,
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
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.requestId,
          method,
          params,
        }),
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

    if (!response.ok) {
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

    const envelope = payload as {
      error?: { code?: number; message?: string };
      result?: T;
    };

    if (envelope.error) {
      const message = envelope.error.message ?? "unknown RPC error";
      throw new RpcCallError({
        kind: classifyRpcErrorMessage(message),
        endpoint: endpoint.url,
        method,
        message,
        ...(envelope.error.code !== undefined ? { rpcCode: envelope.error.code } : {}),
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
    // it against health would demote a perfectly good archive node.
    if (failure.kind === "LOG_RANGE_TOO_WIDE") return;
    endpoint.consecutiveFailures += 1;
    if (endpoint.consecutiveFailures >= this.failureThreshold) {
      endpoint.cooldownUntil = this.now() + this.cooldownMs;
    }
  }
}
