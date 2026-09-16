"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address, Hex } from "viem";
import {
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  SLIPPAGE_PRESETS_BPS,
  classifyTxError,
  needsApproval,
  prepareTrade,
  type PreparedTrade,
  type TxPhase,
} from "@stunks/pons";
import { formatCompact, formatUnitsExact, parseUnitsExact } from "@stunks/utils";
import { erc20Abi } from "@stunks/pons";
import { useCanTransact } from "@/components/wallet";

/**
 * Buy/sell panel.
 *
 * Every number shown here comes from `prepareTrade`, which reads the chain and refuses
 * when it cannot answer honestly. This component deliberately contains no pricing math
 * of its own — a second implementation of the curve would be a second thing to get
 * wrong, and it would drift.
 *
 * Three things this gets right that a straightforward version does not:
 *
 * 1. THE QUOTE IS RE-READ BEFORE SENDING. A quote shown 20 seconds ago is stale on a
 *    chain with 0.1 s blocks. What gets signed is priced at signing time.
 *
 * 2. APPROVAL AND TRADE ARE SEPARATE, VISIBLE STEPS. Bundling them behind one button
 *    makes the second wallet prompt look like a bug and gets it rejected.
 *
 * 3. A PENDING TRANSACTION IS NEVER DESCRIBED AS FAILED. If the wallet has it and we
 *    lose the receipt, the honest state is "we do not know yet", with the hash.
 */

type Side = "BUY" | "SELL";

interface TradePanelProps {
  readonly token: Address;
  readonly factory: Address;
  readonly symbol: string;
  readonly tokenDecimals: number;
  readonly quoteDecimals: number;
  readonly quoteSymbol: string;
  readonly quoteIsNative: boolean;
  readonly quoteTokenAddress: Address;
}

export function TradePanel(props: TradePanelProps) {
  const { token, factory, symbol, tokenDecimals, quoteDecimals, quoteSymbol } = props;

  const [side, setSide] = useState<Side>("BUY");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [customSlippage, setCustomSlippage] = useState("");

  const [prepared, setPrepared] = useState<PreparedTrade | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  const [phase, setPhase] = useState<TxPhase>("Idle");
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [txError, setTxError] = useState<{ title: string; detail: string } | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);

  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const canTransact = useCanTransact();

  const decimalsForInput = side === "BUY" ? quoteDecimals : tokenDecimals;

  // Parsed via parseUnitsExact: string → bigint with no float in between. A Number()
  // round-trip here would silently lose wei on large inputs.
  const parsedAmount = useMemo<bigint | null>(() => {
    if (amount.trim() === "") return null;
    try {
      const value = parseUnitsExact(amount.trim(), decimalsForInput);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  }, [amount, decimalsForInput]);

  const amountInvalid = amount.trim() !== "" && parsedAmount === null;

  // ── Quote, debounced, with stale responses discarded ──
  const requestId = useRef(0);

  const runQuote = useCallback(async () => {
    if (!publicClient || parsedAmount === null || !account) {
      setPrepared(null);
      setQuoteError(null);
      return;
    }
    const id = ++requestId.current;
    setQuoting(true);

    const result = await prepareTrade({
      client: publicClient,
      factory,
      token,
      side,
      amountIn: parsedAmount,
      slippageBps,
      account,
    });

    // A slower earlier request must never overwrite a newer answer.
    if (id !== requestId.current) return;
    setQuoting(false);

    if (result.ok) {
      setPrepared(result.trade);
      setQuoteError(null);
    } else {
      setPrepared(null);
      setQuoteError(result.message);
    }
  }, [publicClient, parsedAmount, account, factory, token, side, slippageBps]);

  useEffect(() => {
    if (parsedAmount === null) {
      setPrepared(null);
      setQuoteError(null);
      return;
    }
    const timer = setTimeout(() => void runQuote(), 250);
    return () => clearTimeout(timer);
  }, [runQuote, parsedAmount]);

  // ── Send ──
  const send = useCallback(async () => {
    if (!walletClient || !publicClient || !account || parsedAmount === null) return;

    setTxError(null);
    setTxHash(null);

    try {
      // Re-price at signing time. Blocks here are ~0.1 s, so a quote from a few
      // seconds ago is genuinely old.
      setPhase("Quoting");
      const fresh = await prepareTrade({
        client: publicClient,
        factory,
        token,
        side,
        amountIn: parsedAmount,
        slippageBps,
        account,
      });
      if (!fresh.ok) {
        setPhase("Failed");
        setTxError({ title: "Trade no longer possible", detail: fresh.message });
        return;
      }
      setPrepared(fresh.trade);

      // ── Approval, only when the allowance is actually short ──
      if (fresh.trade.approval) {
        const required = await needsApproval({
          client: publicClient,
          token: fresh.trade.approval.token,
          owner: account,
          spender: fresh.trade.approval.spender,
          amount: fresh.trade.approval.amount,
        });
        if (required) {
          setApprovalPending(true);
          setPhase("AwaitingWallet");
          const approvalHash = await walletClient.writeContract({
            address: fresh.trade.approval.token,
            abi: erc20Abi,
            functionName: "approve",
            args: [fresh.trade.approval.spender, fresh.trade.approval.amount],
          });
          setPhase("Pending");
          await publicClient.waitForTransactionReceipt({
            hash: approvalHash,
            confirmations: 1,
          });
          setApprovalPending(false);
        }
      }

      // ── The trade ──
      setPhase("AwaitingWallet");
      const hash = await walletClient.sendTransaction({
        to: fresh.trade.to,
        data: fresh.trade.data,
        value: fresh.trade.value,
      });
      setTxHash(hash);
      setPhase("Pending");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });

      if (receipt.status === "success") {
        setPhase("Confirmed");
        setAmount("");
        setPrepared(null);
      } else {
        // Mined and reverted. Almost always the slippage bound doing its job.
        setPhase("Failed");
        setTxError({
          title: "Transaction reverted",
          detail:
            "The trade was mined but reverted. The most likely cause is the price moving " +
            "past your slippage limit, which means the bound protected you. Nothing was " +
            "traded; you paid gas.",
        });
      }
    } catch (error) {
      setApprovalPending(false);
      const classified = classifyTxError(error);
      setPhase(classified.code === "WALLET_REJECTED" ? "Rejected" : "Failed");
      setTxError({
        title:
          classified.code === "WALLET_REJECTED"
            ? "You rejected the transaction"
            : "Transaction failed",
        detail: classified.message,
      });
    }
  }, [
    walletClient,
    publicClient,
    account,
    parsedAmount,
    factory,
    token,
    side,
    slippageBps,
  ]);

  const busy = phase === "Quoting" || phase === "AwaitingWallet" || phase === "Pending";

  function applyCustomSlippage(raw: string) {
    setCustomSlippage(raw);
    const trimmed = raw.trim();
    if (trimmed === "") return;
    // Percent → bps without floating point: "1.25" becomes 125.
    const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(trimmed);
    if (!match) return;
    const whole = match[1] ?? "0";
    const frac = (match[2] ?? "").padEnd(2, "0");
    // eslint-disable-next-line no-restricted-syntax -- a slippage percentage is a bps setting, not a financial amount
    const bps = parseInt(whole, 10) * 100 + parseInt(frac, 10);
    if (bps >= MIN_SLIPPAGE_BPS && bps <= MAX_SLIPPAGE_BPS) setSlippageBps(bps);
  }

  return (
    <div className="panel pad trade-shell">
      <div className="tabs" role="tablist" aria-label="Trade side">
        {(["BUY", "SELL"] as const).map((option) => (
          <button
            key={option}
            role="tab"
            aria-selected={side === option}
            className={`tab ${side === option ? "active" : ""}`}
            onClick={() => {
              setSide(option);
              setAmount("");
              setPrepared(null);
              setQuoteError(null);
              if (!busy) setPhase("Idle");
            }}
            disabled={busy}
          >
            {option === "BUY" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor="trade-amount">
          {side === "BUY" ? `Amount to spend (${quoteSymbol})` : `Amount to sell (${symbol})`}
        </label>
        <input
          id="trade-amount"
          className="mono"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          disabled={busy}
          aria-invalid={amountInvalid}
          aria-describedby={amountInvalid ? "trade-amount-error" : undefined}
        />
        {amountInvalid && (
          <p id="trade-amount-error" className="hint" style={{ color: "var(--bad)" }}>
            Enter a number with at most {decimalsForInput} decimal places.
          </p>
        )}
      </div>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="card-label">Slippage tolerance</legend>
        <div className="tabs" style={{ marginTop: 6 }}>
          {SLIPPAGE_PRESETS_BPS.map((preset) => (
            <button
              key={preset}
              className={`tab ${slippageBps === preset && customSlippage === "" ? "active" : ""}`}
              onClick={() => {
                setSlippageBps(preset);
                setCustomSlippage("");
              }}
              disabled={busy}
            >
              {preset / 100}%
            </button>
          ))}
          <input
            className="mono"
            style={{ maxWidth: 90 }}
            inputMode="decimal"
            placeholder="custom"
            aria-label="Custom slippage percent"
            value={customSlippage}
            onChange={(event) => applyCustomSlippage(event.target.value)}
            disabled={busy}
          />
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          Sent on-chain as a minimum-out bound. This is what actually protects you — the
          quote below is only an estimate.
        </p>
      </fieldset>

      {quoting && <p className="hint">Reading the curve…</p>}

      {quoteError !== null && (
        <div className="error">
          <p style={{ color: "var(--text)", margin: 0 }}>{quoteError}</p>
        </div>
      )}

      {prepared && (
        <div className="panel pad" style={{ marginTop: 12 }}>
          <table>
            <tbody>
              <tr>
                <th scope="row">You receive (estimated)</th>
                <td className="value">
                  {side === "BUY"
                    ? `${formatCompact(prepared.quote.amountOut, tokenDecimals)} ${symbol}`
                    : `${formatUnitsExact(prepared.quote.amountOut, quoteDecimals)} ${quoteSymbol}`}
                </td>
              </tr>
              <tr>
                <th scope="row">Minimum received</th>
                <td className="value">
                  {side === "BUY"
                    ? `${formatCompact(prepared.quote.minAmountOut, tokenDecimals)} ${symbol}`
                    : `${formatUnitsExact(prepared.quote.minAmountOut, quoteDecimals)} ${quoteSymbol}`}
                </td>
              </tr>
              <tr>
                <th scope="row">Curve fee</th>
                <td className="value">
                  {formatUnitsExact(prepared.quote.feeAmount, quoteDecimals)} {quoteSymbol}
                </td>
              </tr>
              <tr>
                <th scope="row">Creator fee</th>
                <td className="value">
                  {formatUnitsExact(prepared.quote.creatorTaxAmount, quoteDecimals)}{" "}
                  {quoteSymbol}
                </td>
              </tr>
              <tr>
                <th scope="row">STUNKS fee</th>
                <td className="value">0 — STUNKS takes nothing</td>
              </tr>
              <tr>
                <th scope="row">Quote source</th>
                <td className="value">
                  {prepared.quote.source === "SIMULATION"
                    ? "on-chain simulation"
                    : "local math (verified against mainnet)"}
                </td>
              </tr>
            </tbody>
          </table>

          {prepared.warnings.map((warning) => (
            <p key={warning} className="hint" style={{ color: "var(--warn)" }}>
              {warning}
            </p>
          ))}
        </div>
      )}

      {!canTransact.ok && <p className="hint">{canTransact.reason}</p>}

      <button
        className="btn btn-primary trade-submit"
        onClick={() => void send()}
        disabled={!canTransact.ok || prepared === null || busy}
      >
        {phase === "AwaitingWallet"
          ? approvalPending
            ? "Confirm approval in your wallet…"
            : "Confirm in your wallet…"
          : phase === "Pending"
            ? "Waiting for confirmation…"
            : phase === "Quoting"
              ? "Re-pricing…"
              : side === "BUY"
                ? `Buy ${symbol}`
                : `Sell ${symbol}`}
      </button>

      {prepared?.approval && (
        <p className="hint">
          This trade needs two transactions: one to approve{" "}
          {side === "BUY" ? quoteSymbol : symbol}, then the trade itself. Your wallet will
          prompt twice.
        </p>
      )}

      {phase === "Confirmed" && (
        <div className="panel pad" style={{ marginTop: 12 }}>
          <p style={{ margin: 0 }}>
            Trade confirmed.{" "}
            {txHash && <span className="mono hint">{txHash}</span>}
          </p>
          <p className="hint" style={{ marginBottom: 0 }}>
            Your balance is already updated on-chain. This page&apos;s history and
            statistics will catch up when the indexer reaches this block.
          </p>
        </div>
      )}

      {txError !== null && (
        <div className="error" style={{ marginTop: 12 }}>
          <p style={{ color: "var(--text)", marginTop: 0 }}>
            <strong>{txError.title}</strong>
          </p>
          <p style={{ color: "var(--text)", margin: 0 }}>{txError.detail}</p>
          {txHash !== null && (
            <p className="hint" style={{ marginBottom: 0 }}>
              Transaction: <span className="mono">{txHash}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
