/**
 * RPC failure taxonomy.
 *
 * The distinction that matters most here is NON_JSON_RESPONSE. During the audit,
 * a throttled public endpoint answered a JSON-RPC request with an HTML 403 page.
 * A client that treats any HTTP 200/403 body as an answer will parse that as
 * garbage or, worse, as an absent result — which for `eth_getCode` or
 * `eth_getLogs` looks exactly like "the contract has no code" or "there were no
 * events". Those are silent, wrong, and indistinguishable from truth unless the
 * transport classifies them as failures.
 */

export type RpcFailureKind =
  | "NON_JSON_RESPONSE"
  | "RATE_LIMITED"
  | "LOG_RANGE_TOO_WIDE"
  /** Endpoint has not indexed a block another endpoint already reported as head. */
  | "BLOCK_UNAVAILABLE"
  /** Provider accepts JSON-RPC but is temporarily unable to serve the query. */
  | "UPSTREAM_UNAVAILABLE"
  /** Endpoint refuses a JSON-RPC batch this large. Its real limit is plan-dependent. */
  | "BATCH_TOO_LARGE"
  | "TIMEOUT"
  | "NETWORK"
  | "HTTP_ERROR"
  | "RPC_ERROR";

export class RpcCallError extends Error {
  readonly kind: RpcFailureKind;
  readonly endpoint: string;
  readonly method: string;
  readonly statusCode?: number;
  readonly rpcCode?: number;

  constructor(args: {
    kind: RpcFailureKind;
    endpoint: string;
    method: string;
    message: string;
    statusCode?: number;
    rpcCode?: number;
    cause?: unknown;
  }) {
    super(`[${args.kind}] ${args.method} via ${args.endpoint}: ${args.message}`, {
      cause: args.cause,
    });
    this.name = "RpcCallError";
    this.kind = args.kind;
    this.endpoint = args.endpoint;
    this.method = args.method;
    if (args.statusCode !== undefined) this.statusCode = args.statusCode;
    if (args.rpcCode !== undefined) this.rpcCode = args.rpcCode;
  }
}

/** Every endpoint failed. Carries each underlying failure for diagnosis. */
export class AllEndpointsFailedError extends Error {
  readonly failures: readonly RpcCallError[];

  constructor(method: string, failures: readonly RpcCallError[]) {
    const summary = failures.map((f) => `  ${f.endpoint}: ${f.kind}`).join("\n");
    super(`All RPC endpoints failed for ${method}:\n${summary}`);
    this.name = "AllEndpointsFailedError";
    this.failures = failures;
  }
}

/**
 * A wrong-chain answer is a hard stop, never a retryable condition. Signing
 * against the wrong chain is exactly the class of mistake that loses funds.
 */
export class ChainMismatchError extends Error {
  constructor(expected: number, actual: number, endpoint: string) {
    super(
      `Chain mismatch: expected ${expected}, endpoint ${endpoint} reported ${actual}. ` +
        `Refusing to proceed.`,
    );
    this.name = "ChainMismatchError";
  }
}

/**
 * Find an RpcCallError anywhere in an error's cause chain.
 *
 * Callers reach the pool through viem, and viem wraps whatever a custom transport
 * throws inside its own error types. A plain `error instanceof RpcCallError` check
 * therefore misses, which is how the adaptive log window came to never narrow: the
 * signal to narrow was raised correctly and then never recognised.
 */
export function findRpcCallError(error: unknown): RpcCallError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (current instanceof RpcCallError) return current;
    seen.add(current);
    if (current instanceof AllEndpointsFailedError) {
      // Every endpoint failed; report the most actionable reason rather than the first.
      const ranked = [...current.failures].sort(
        (a, b) => failurePriority(b.kind) - failurePriority(a.kind),
      );
      return ranked[0] ?? null;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

/** A range rejection tells the caller what to do; a network blip does not. */
function failurePriority(kind: RpcFailureKind): number {
  switch (kind) {
    case "LOG_RANGE_TOO_WIDE":
      return 3;
    case "BATCH_TOO_LARGE":
      return 2;
    case "TIMEOUT":
      return 1;
    default:
      return 0;
  }
}

/** Failures worth trying another endpoint for. */
export function isRetryable(kind: RpcFailureKind): boolean {
  switch (kind) {
    case "NON_JSON_RESPONSE":
    case "RATE_LIMITED":
    case "BLOCK_UNAVAILABLE":
    case "UPSTREAM_UNAVAILABLE":
    case "TIMEOUT":
    case "NETWORK":
    case "HTTP_ERROR":
      return true;
    // Another endpoint may allow a batch this size, so it is worth moving on — but
    // the pool records the rejected size so the same endpoint is not asked again.
    case "BATCH_TOO_LARGE":
      return true;
    // A revert or a bad parameter will fail identically everywhere, and a range
    // that is too wide needs the caller to split it, not a different endpoint.
    case "RPC_ERROR":
    case "LOG_RANGE_TOO_WIDE":
      return false;
  }
}

const RATE_LIMIT_PATTERNS = [/rate limit/i, /too many requests/i, /429/];
const LOG_RANGE_PATTERNS = [
  /ranges over \d+ blocks are not supported/i,
  /block range too (large|wide)/i,
  /query returned more than \d+ results/i,
  /log response size exceeded/i,
];

const BLOCK_UNAVAILABLE_PATTERNS = [
  // Observed on Robinhood RPC nodes when one provider reports the head before another
  // one has indexed it. This is an availability problem, not an invalid block number.
  /\bblock at number\s+"?\d+"?\s+could not be found\b/i,
];

const UPSTREAM_UNAVAILABLE_PATTERNS = [
  // OrdoFi has returned both forms while its eth_getLogs backend is overloaded. They
  // are not caller mistakes: retrying a smaller range cannot make a one-block query
  // acceptable, and a different provider can serve the same query.
  /\bnetwork is busy,? please try again\b/i,
  /\bblock\s+\d+\s+alone returns more logs than the upstream will serve\b/i,
];

const BATCH_TOO_LARGE_PATTERNS = [
  // dRPC's free plan, measured: a batch of 10, 25, 50 or 100 all come back as HTTP 500
  // with this message on every entry, while a batch of 3 succeeds.
  /batch of more than \d+ requests? (are|is) not allowed/i,
  /batch (size|request).{0,20}(not allowed|not supported|too large|exceed)/i,
];

/**
 * The allowed batch size an endpoint reported while rejecting a larger one.
 *
 * Endpoints in this pool have a track record of misreporting their own limits, so the
 * number is treated as a hint: the caller still records the size that actually failed.
 */
export function parseAllowedBatchSize(message: string): number | null {
  const match = /batch of more than (\d+) requests?/i.exec(message);
  if (!match?.[1]) return null;
  // eslint-disable-next-line no-restricted-syntax -- a batch size is not money
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** No endpoint in the pool will serve a JSON-RPC batch of the requested size. */
export class BatchNotSupportedError extends Error {
  constructor(
    readonly requested: number,
    message: string,
  ) {
    super(message);
    this.name = "BatchNotSupportedError";
  }
}

export function classifyRpcErrorMessage(message: string): RpcFailureKind {
  if (LOG_RANGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return "LOG_RANGE_TOO_WIDE";
  }
  if (BATCH_TOO_LARGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return "BATCH_TOO_LARGE";
  }
  if (BLOCK_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message))) {
    return "BLOCK_UNAVAILABLE";
  }
  if (UPSTREAM_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message))) {
    return "UPSTREAM_UNAVAILABLE";
  }
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "RATE_LIMITED";
  }
  return "RPC_ERROR";
}
