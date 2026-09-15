"use client";

import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address } from "viem";
import {
  EXEMPTION_DISCLOSURES,
  MAX_DECLARABLE_SNIPE_EXEMPTIONS,
  NATIVE_PAIR_TOKEN,
  buildLaunchTransaction,
  classifyTxError,
  snipeTaxSchedule,
  validateSnipeExemptions,
  type TxState,
} from "@stunks/pons";
import { formatUnitsExact, parseUnitsExact } from "@stunks/utils";
import { useCanTransact } from "@/components/wallet";

/**
 * Protected Launch form.
 *
 * The whole feature rests on one verified fact: the Pons anti-snipe tax is evaluated
 * against the token RECIPIENT, not the transaction sender. That is why a single funded
 * wallet can deliver untaxed tokens to up to 31 whitelisted addresses, and why none of
 * those addresses ever has to sign anything or hold ETH.
 *
 * The copy here is deliberately unflattering in places. The advantage is real but
 * brief, the whitelist is permanent and public, and the cap is enforced only after the
 * launch fee is taken. Users who find that out afterwards would be right to be angry.
 */

interface LaunchFormProps {
  readonly factory: Address;
  readonly router: Address;
  readonly launchFee: string;
  readonly maxCreatorTaxBps: number;
  readonly snipeTaxStartBps: number;
  readonly snipeTaxSeconds: number;
  readonly launchConfigId: string;
}

export function LaunchForm(props: LaunchFormProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const canTransact = useCanTransact();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [description, setDescription] = useState("");
  const [creatorTaxPercent, setCreatorTaxPercent] = useState("2");
  const [devBuyEth, setDevBuyEth] = useState("0.01");
  const [whitelistText, setWhitelistText] = useState("");
  const [tx, setTx] = useState<TxState>({ phase: "Idle" });

  const whitelistEntries = useMemo(
    () =>
      whitelistText
        .split(/[\s,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    [whitelistText],
  );

  const exemptions = useMemo(
    () =>
      address
        ? validateSnipeExemptions({ addresses: whitelistEntries, deployer: address })
        : null,
    [whitelistEntries, address],
  );

  // The decay is what makes the advantage brief. Showing it prevents the feature from
  // being read as "three seconds of protection", which it is not.
  const decay = useMemo(
    () => snipeTaxSchedule(BigInt(props.snipeTaxStartBps), BigInt(props.snipeTaxSeconds)),
    [props.snipeTaxStartBps, props.snipeTaxSeconds],
  );

  const busy =
    tx.phase === "Quoting" || tx.phase === "AwaitingWallet" || tx.phase === "Pending";

  async function submit(): Promise<void> {
    if (!publicClient || !walletClient || !address) return;

    setTx({ phase: "Quoting", message: "Reading live launch terms…" });

    try {
      // A percentage with two decimal places is exactly basis points, so the tax
      // never passes through a float.
      const creatorTaxBps = parseUnitsExact(creatorTaxPercent || "0", 2);
      const built = await buildLaunchTransaction(
        publicClient,
        props.factory,
        props.router,
        {
          name,
          symbol,
          logo,
          description,
          creator: address,
          // eslint-disable-next-line no-restricted-syntax -- bps is a bounded integer (0..1000), not an amount
          creatorTaxBps: Number(creatorTaxBps),
          buybackEnabled: true,
          launchConfigId: BigInt(props.launchConfigId),
          pairToken: NATIVE_PAIR_TOKEN,
          devBuyAmount: parseUnitsExact(devBuyEth || "0", 18),
          minTokensOut: 0n,
          whitelist: whitelistEntries,
        },
      );

      if (!built.ok) {
        setTx({
          phase: "Failed",
          message: built.errors.join(" "),
          errorCode: "REVERTED",
        });
        return;
      }

      setTx({
        phase: "AwaitingWallet",
        message: "Confirm in your wallet. The amount must match exactly.",
      });

      const hash = await walletClient.sendTransaction({
        to: built.launch.to,
        data: built.launch.data,
        // Exact: Pons compares msg.value with !=, not <.
        value: built.launch.value,
      });

      setTx({ phase: "Pending", hash, message: "Waiting for the transaction to mine…" });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        // 100 ms blocks: the 4-second default would be slower than the window itself.
        pollingInterval: 100,
      });

      if (receipt.status !== "success") {
        setTx({
          phase: "Failed",
          hash,
          message: "The transaction was mined but reverted. No token was launched.",
          errorCode: "REVERTED",
        });
        return;
      }

      // Mined is not the same as usable. The launch still has to be indexed before it
      // appears in STUNKS, and saying otherwise would be a lie the PRD explicitly
      // forbids.
      setTx({
        phase: "Confirmed",
        hash,
        blockNumber: receipt.blockNumber,
        message:
          "Launched on-chain. It will appear in STUNKS once the indexer picks it up.",
      });
    } catch (error) {
      const classified = classifyTxError(error);
      setTx({
        phase: classified.code === "WALLET_REJECTED" ? "Rejected" : "Failed",
        message: classified.message,
        errorCode: classified.code,
      });
    }
  }

  return (
    <div className="stack">
      <section className="panel pad">
        <h2>Token</h2>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </label>
        <label className="field">
          <span>Symbol</span>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            maxLength={16}
          />
        </label>
        <label className="field">
          <span>Image URI</span>
          <input
            value={logo}
            onChange={(e) => setLogo(e.target.value)}
            placeholder="ipfs://…"
          />
          <small>
            Prefer <code>ipfs://</code>. A gateway URL makes your token&apos;s on-chain
            metadata depend permanently on one company&apos;s endpoint.
          </small>
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={512}
            rows={3}
          />
        </label>
      </section>

      <section className="panel pad">
        <h2>Economics</h2>
        <label className="field">
          <span>Creator tax (%)</span>
          <input
            value={creatorTaxPercent}
            onChange={(e) => setCreatorTaxPercent(e.target.value)}
            inputMode="decimal"
          />
          <small>
            Paid to you on every trade, on top of the 1% curve fee. Protocol ceiling is
            currently {props.maxCreatorTaxBps / 100}%. Traders see this before they buy.
          </small>
        </label>
        <label className="field">
          <span>Your opening buy (ETH)</span>
          <input
            value={devBuyEth}
            onChange={(e) => setDevBuyEth(e.target.value)}
            inputMode="decimal"
          />
          <small>
            Executed in the same transaction as the launch, so it cannot be front-run.
          </small>
        </label>
        <p className="hint">
          Launch fee:{" "}
          <span className="mono">
            {formatUnitsExact(BigInt(props.launchFee), 18)} ETH
          </span>{" "}
          to Pons. STUNKS charges nothing.
        </p>
      </section>

      <section className="panel pad">
        <h2>Protected launch — whitelist</h2>
        <p className="hint">
          Whitelisted addresses pay no anti-snipe tax. Because Pons checks the tax against
          the <strong>recipient</strong> rather than the sender, your single wallet can
          buy for all of them — they never sign anything and never need ETH.
        </p>

        <div className="panel inner">
          <table className="compact">
            <thead>
              <tr>
                <th>Age</th>
                <th>Tax for everyone else</th>
              </tr>
            </thead>
            <tbody>
              {decay.map((step) => (
                <tr key={step.elapsedSeconds.toString()}>
                  <td className="mono">{step.elapsedSeconds.toString()}s</td>
                  <td className="mono">
                    {/* eslint-disable-next-line no-restricted-syntax -- formatting bps as a percentage for display only */}
                    {(Number(step.taxBps) / 100).toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Read that table before relying on this. The edge is the launch block, not the
          whole window — by {props.snipeTaxSeconds - 1}s a sniper pays almost nothing.
        </p>

        <label className="field">
          <span>
            Recipient addresses ({exemptions?.slotsUsed ?? 0} /{" "}
            {MAX_DECLARABLE_SNIPE_EXEMPTIONS})
          </span>
          <textarea
            value={whitelistText}
            onChange={(e) => setWhitelistText(e.target.value)}
            rows={5}
            placeholder="One address per line"
          />
        </label>

        {exemptions?.errors.map((error) => (
          <p key={error} className="hint error-text">
            {error}
          </p>
        ))}
        {exemptions?.warnings.map((warning) => (
          <p key={warning} className="hint">
            {warning}
          </p>
        ))}

        <ul className="disclosures">
          {EXEMPTION_DISCLOSURES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="panel pad">
        <h2>Launch</h2>
        {!canTransact.ok && <p className="hint error-text">{canTransact.reason}</p>}

        <button
          type="button"
          className="btn btn-primary"
          disabled={
            !canTransact.ok ||
            busy ||
            (exemptions?.errors.length ?? 0) > 0 ||
            name.trim() === "" ||
            symbol.trim() === "" ||
            logo.trim() === ""
          }
          onClick={() => void submit()}
        >
          {busy ? "Working…" : "Launch token"}
        </button>

        <TxStatus state={tx} />
      </section>
    </div>
  );
}

/**
 * Transaction status.
 *
 * `Confirmed` is deliberately not presented as "done". Signed, mined and indexed are
 * three different things, and collapsing them is how a UI ends up telling someone they
 * own a token that does not exist yet.
 */
function TxStatus({ state }: { state: TxState }) {
  if (state.phase === "Idle") return null;

  const tone =
    state.phase === "Failed" || state.phase === "Rejected"
      ? "warn"
      : state.phase === "Confirmed"
        ? "ok"
        : "";

  return (
    <div className="txstatus">
      <p>
        <span className={`badge ${tone}`}>{state.phase}</span>
      </p>
      {state.message && <p className="hint">{state.message}</p>}
      {state.hash && (
        <p className="hint mono">
          <a
            href={`https://robinhoodchain.blockscout.com/tx/${state.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction
          </a>
        </p>
      )}
      {state.phase === "Confirmed" && (
        <p className="hint">
          Next: buy for your whitelisted addresses as quickly as possible. The tax for
          everyone else is already decaying.
        </p>
      )}
    </div>
  );
}
