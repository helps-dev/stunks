"use client";

import {
  useAccount,
  useBalance,
  useChainId,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { formatUnitsExact } from "@stunks/utils";
import { ROBINHOOD_CHAIN_ID } from "@/lib/wagmi";

/**
 * Wallet connection and the chain guard.
 *
 * The guard is not cosmetic. Every address in this app is keyed to chain 4663, and a
 * transaction signed on another chain could go to an entirely different contract at
 * the same address. So being on the wrong network BLOCKS signing rather than warning
 * about it — see `useCanTransact` below, which the launch form gates on.
 */

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

interface ConnectWalletProps {
  /** Compact presentation for global navigation; all chain guards remain identical. */
  readonly compact?: boolean;
}

export function ConnectWallet({ compact = false }: ConnectWalletProps) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: balance } = useBalance({ address });

  const injected = connectors[0];
  const wrongChain = isConnected && chainId !== ROBINHOOD_CHAIN_ID;

  if (!isConnected) {
    return (
      <div className={compact ? "wallet wallet-compact" : "wallet"}>
        <button
          type="button"
          className="btn btn-primary btn-wallet"
          disabled={isPending || !injected}
          onClick={() => injected && connect({ connector: injected })}
        >
          {isPending ? "Check wallet…" : "Connect wallet"}
        </button>
        {!compact && !injected && (
          <p className="hint">
            No browser wallet detected. Install one to launch or trade.
          </p>
        )}
        {compact && !injected && (
          <span className="wallet-compact-note" role="status">
            No wallet detected
          </span>
        )}
        {!compact && error && <p className="hint error-text">{error.message}</p>}
        {compact && error && (
          <span className="wallet-compact-note wallet-compact-error" role="status">
            Wallet connection failed
          </span>
        )}
        {!compact && (
          <p className="hint">
            STUNKS never asks for a private key or seed phrase, and cannot move your
            funds. Every action is signed in your own wallet.
          </p>
        )}
      </div>
    );
  }

  if (wrongChain) {
    return (
      <div className={compact ? "wallet wallet-compact" : "wallet"}>
        {!compact && <p className="badge warn">Wrong network</p>}
        {compact && (
          <span className="wallet-compact-note wallet-compact-error">Wrong network</span>
        )}
        {!compact && (
          <p className="hint">
            Your wallet is on chain {chainId}. STUNKS only works on Robinhood Chain (
            {ROBINHOOD_CHAIN_ID}), and signing here could interact with a different
            contract at the same address.
          </p>
        )}
        <button
          type="button"
          className="btn btn-warning"
          disabled={isSwitching}
          onClick={() => switchChain({ chainId: ROBINHOOD_CHAIN_ID })}
        >
          {isSwitching ? "Switching…" : "Use Robinhood Chain"}
        </button>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="wallet wallet-compact">
        <button
          type="button"
          className="btn btn-wallet-connected mono"
          onClick={() => disconnect()}
          aria-label={`Disconnect wallet ${address ?? ""}`}
          title="Disconnect wallet"
        >
          <span className="status-dot" /> {address ? shortAddress(address) : "Connected"}
        </button>
      </div>
    );
  }

  return (
    <div className="wallet">
      <div className="wallet-row">
        <span className="badge ok">Connected</span>
        <span className="mono">{address ? shortAddress(address) : ""}</span>
      </div>
      {balance && (
        <p className="hint mono">
          {formatUnitsExact(balance.value, balance.decimals)} {balance.symbol}
        </p>
      )}
      <button type="button" className="btn btn-quiet" onClick={() => disconnect()}>
        Disconnect
      </button>
    </div>
  );
}

/**
 * Whether it is safe to let the user sign.
 *
 * Returns a reason when it is not, so the calling form can explain rather than just
 * disable a button.
 */
export function useCanTransact(): { ok: boolean; reason?: string } {
  const { isConnected } = useAccount();
  const chainId = useChainId();

  if (!isConnected) return { ok: false, reason: "Connect your wallet first." };
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    return {
      ok: false,
      reason: `Switch to Robinhood Chain (${ROBINHOOD_CHAIN_ID}) before signing.`,
    };
  }
  return { ok: true };
}
