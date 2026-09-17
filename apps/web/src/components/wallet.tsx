"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

type Connector = ReturnType<typeof useConnect>["connectors"][number];

/**
 * The wallet chooser.
 *
 * A native `<dialog>` opened with `showModal()`, rather than a div with a high
 * z-index. That hands over focus trapping, Escape to close, inert background content
 * and a real `::backdrop` — all of which a hand-rolled overlay has to reimplement, and
 * usually only partly.
 *
 * It is also why this cannot disturb the page: a modal dialog is taken out of the
 * document flow entirely. The first version of this was a dropdown in the header's
 * flex row, and with eight wallets discovered it grew the header by four hundred
 * pixels and pushed the whole page down.
 */
function WalletDialog({
  open,
  onClose,
  connectors,
  busy,
  pendingName,
  onPick,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly connectors: readonly Connector[];
  readonly busy: boolean;
  readonly pendingName?: string | undefined;
  readonly onPick: (connector: Connector) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="wallet-dialog"
      // Escape fires `cancel`, and the browser closes the dialog itself; this keeps
      // React's state in step rather than letting the two disagree.
      onCancel={onClose}
      onClose={onClose}
      // The dialog element fills the viewport for hit-testing, so a click landing on
      // the element itself — rather than on the card inside it — is a backdrop click.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="wallet-dialog-card">
        <header className="wallet-dialog-head">
          <div>
            <h2>Connect wallet</h2>
            <p>Choose a wallet to continue.</p>
          </div>
          <button
            type="button"
            className="wallet-dialog-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <ul className="wallet-list" role="list">
          {connectors.map((connector) => (
            <li key={connector.uid}>
              <button
                type="button"
                className="wallet-option"
                disabled={busy}
                onClick={() => onPick(connector)}
              >
                {connector.icon ? (
                  // A plain <img>, not next/image: the wallet supplies this over
                  // EIP-6963 as a data URI, which the image optimiser cannot process
                  // and does not need to.
                  <img src={connector.icon} alt="" width={28} height={28} />
                ) : (
                  <span className="wallet-option-blank" aria-hidden="true" />
                )}
                <span className="wallet-option-name">{connector.name}</span>
                <span className="wallet-option-action">
                  {busy && pendingName === connector.name ? "Waiting…" : "Connect"}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="wallet-dialog-foot">
          STUNKS never sees your keys and cannot move your funds. Every action is signed
          in your own wallet.
        </p>
      </div>
    </dialog>
  );
}

export function ConnectWallet({ compact = false }: ConnectWalletProps) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending, error, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { data: balance } = useBalance({ address });
  const [picking, setPicking] = useState(false);

  /**
   * Every wallet on offer, de-duplicated.
   *
   * wagmi lists one connector per EIP-6963 wallet the browser announces, plus the ones
   * configured by hand. A browser with several wallets installed can also announce the
   * same one twice — once discovered, once as the generic `injected` fallback — so
   * entries are keyed by name and the discovered copy wins.
   *
   * This replaces `connectors[0]`, which connected to whichever wallet wagmi happened
   * to list first. On a machine with many extensions that is a coin toss, and when it
   * chose one the user was not using, the failure surfaced as "Wallet connection
   * failed" with no indication that the wrong wallet had been asked.
   */
  const available = useMemo(() => {
    const byName = new Map<string, (typeof connectors)[number]>();
    for (const connector of connectors) {
      const existing = byName.get(connector.name);
      // A discovered wallet carries its own icon; prefer it over the bare fallback.
      if (!existing || (!existing.icon && connector.icon)) {
        byName.set(connector.name, connector);
      }
    }
    return [...byName.values()];
  }, [connectors]);

  const wrongChain = isConnected && chainId !== ROBINHOOD_CHAIN_ID;
  const pendingName = isPending ? variables?.connector?.name : undefined;

  if (!isConnected) {
    const none = available.length === 0;

    return (
      <div className={compact ? "wallet wallet-compact" : "wallet"}>
        <button
          type="button"
          className="btn btn-primary btn-wallet"
          disabled={isPending || none}
          onClick={() => setPicking(true)}
        >
          {isPending ? `Check ${pendingName ?? "wallet"}…` : "Connect wallet"}
        </button>

        <WalletDialog
          open={picking}
          onClose={() => setPicking(false)}
          connectors={available}
          busy={isPending}
          pendingName={pendingName}
          onPick={(connector) => {
            setPicking(false);
            connect({ connector });
          }}
        />

        {none && !compact && (
          <p className="hint">
            No wallet detected. Install a browser wallet, or set
            NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to offer phone wallets.
          </p>
        )}
        {none && compact && (
          <span className="wallet-compact-note" role="status">
            No wallet detected
          </span>
        )}

        {/*
          The real message, not a generic one. "Wallet connection failed" told the user
          nothing they could act on — a rejected request, a locked wallet and a wrong
          network all produced the same four words.
        */}
        {error && !compact && (
          <p className="hint error-text">
            {pendingName ? `${pendingName}: ` : ""}
            {error.message}
          </p>
        )}
        {error && compact && (
          <span
            className="wallet-compact-note wallet-compact-error"
            role="status"
            title={error.message}
          >
            {error.message.slice(0, 60)}
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
