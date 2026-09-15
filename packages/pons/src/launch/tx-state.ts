/**
 * Transaction state machine.
 *
 * The PRD is explicit that "wallet signed", "transaction mined" and "indexer
 * processed" are three different things, and this type makes it impossible to
 * conflate them. A UI that shows success on signature is lying: the transaction can
 * still revert.
 *
 * The states after `Confirmed` matter for STUNKS specifically. A launch is not usable
 * until it is indexed, and the anti-snipe window is only ~3 seconds — so the UI has to
 * distinguish "mined" from "visible in the app" rather than pretending they coincide.
 */

export type TxPhase =
  | "Idle"
  | "Quoting"
  | "AwaitingWallet"
  | "Pending"
  | "Confirmed"
  | "Indexed"
  | "Failed"
  | "Rejected";

export interface TxState {
  readonly phase: TxPhase;
  readonly hash?: `0x${string}`;
  readonly blockNumber?: bigint;
  /** Human-readable, actionable. Never "something went wrong". */
  readonly message?: string;
  readonly errorCode?: TxErrorCode;
}

export type TxErrorCode =
  | "WALLET_REJECTED"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_GAS"
  | "WRONG_NETWORK"
  | "RPC_UNAVAILABLE"
  | "VALUE_MISMATCH"
  | "ECONOMICS_CHANGED"
  | "EXEMPTION_LIST_TOO_LONG"
  | "SLIPPAGE"
  | "REVERTED"
  | "TIMEOUT";

/**
 * Map a wallet or node error into something a user can act on.
 *
 * Two of these are specific to Pons and would otherwise surface as an opaque revert:
 * the exact-value check and the economics pin.
 */
export function classifyTxError(error: unknown): {
  code: TxErrorCode;
  message: string;
} {
  const raw =
    error instanceof Error
      ? `${(error as { shortMessage?: string }).shortMessage ?? ""} ${error.message}`
      : String(error);
  const text = raw.toLowerCase();

  if (
    text.includes("user rejected") ||
    text.includes("user denied") ||
    text.includes("rejected the request")
  ) {
    return { code: "WALLET_REJECTED", message: "You cancelled the transaction." };
  }

  if (text.includes("0xbc760cfe") || text.includes("nativevaluemismatch")) {
    return {
      code: "VALUE_MISMATCH",
      message:
        "The amount sent did not exactly match the launch fee plus your opening buy. " +
        "Pons requires an exact amount. The launch fee may have changed while you were " +
        "reviewing — reload and try again.",
    };
  }

  if (text.includes("launcheconomicsmismatch") || text.includes("economics")) {
    return {
      code: "ECONOMICS_CHANGED",
      message:
        "The launch terms changed on-chain while your transaction was in flight, so it " +
        "was rejected rather than executing at different terms. Reload to get the " +
        "current terms.",
    };
  }

  if (text.includes("exemptionlisttoolong")) {
    return {
      code: "EXEMPTION_LIST_TOO_LONG",
      message: "Too many whitelist addresses. Pons allows at most 31.",
    };
  }

  if (text.includes("slippage") || text.includes("slippageexceeded")) {
    return {
      code: "SLIPPAGE",
      message:
        "The price moved past your slippage limit before the trade settled. Nothing was " +
        "spent. Try again, or raise your slippage tolerance.",
    };
  }

  if (text.includes("insufficient funds") || text.includes("exceeds balance")) {
    return {
      code: "INSUFFICIENT_BALANCE",
      message: "Your wallet does not have enough ETH for this amount plus gas.",
    };
  }

  if (text.includes("gas required exceeds") || text.includes("out of gas")) {
    return { code: "INSUFFICIENT_GAS", message: "The transaction ran out of gas." };
  }

  if (text.includes("chain") && text.includes("mismatch")) {
    return {
      code: "WRONG_NETWORK",
      message: "Your wallet is on the wrong network. Switch to Robinhood Chain.",
    };
  }

  if (
    text.includes("fetch failed") ||
    text.includes("timeout") ||
    text.includes("network error")
  ) {
    return {
      code: "RPC_UNAVAILABLE",
      message:
        "Could not reach the network. Your transaction may or may not have been sent — " +
        "check your wallet before retrying.",
    };
  }

  if (text.includes("reverted")) {
    return {
      code: "REVERTED",
      message: "The transaction was rejected on-chain. No tokens were launched.",
    };
  }

  return {
    code: "REVERTED",
    // Even the fallback carries the underlying text rather than hiding it.
    message: `The transaction failed: ${raw.trim().slice(0, 180)}`,
  };
}

/** Whether a phase represents a settled outcome, so the UI can stop spinning. */
export function isTerminal(phase: TxPhase): boolean {
  return phase === "Indexed" || phase === "Failed" || phase === "Rejected";
}

/** Whether user funds may already have moved. Governs how a retry is worded. */
export function mayHaveSpent(phase: TxPhase): boolean {
  return phase === "Pending" || phase === "Confirmed" || phase === "Indexed";
}
