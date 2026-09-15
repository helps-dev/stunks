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

/** Failures worth trying another endpoint for. */
export function isRetryable(kind: RpcFailureKind): boolean {
  switch (kind) {
    case "NON_JSON_RESPONSE":
    case "RATE_LIMITED":
    case "TIMEOUT":
    case "NETWORK":
    case "HTTP_ERROR":
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

export function classifyRpcErrorMessage(message: string): RpcFailureKind {
  if (LOG_RANGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return "LOG_RANGE_TOO_WIDE";
  }
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "RATE_LIMITED";
  }
  return "RPC_ERROR";
}
