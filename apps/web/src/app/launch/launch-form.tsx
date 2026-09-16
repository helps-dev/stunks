"use client";

import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address } from "viem";
import {
  EXEMPTION_DISCLOSURES,
  MAX_DECLARABLE_SNIPE_EXEMPTIONS,
  NATIVE_PAIR_TOKEN,
  buildBundleTransactions,
  buildLaunchTransaction,
  bundleGasCeiling,
  classifyTxError,
  confirmedLaunchFromReceipt,
  erc20Abi,
  needsApproval,
  planBundle,
  readCurveState,
  validateSnipeExemptions,
  type BundleRecipient,
  type TxState,
} from "@stunks/pons";
import { formatUnitsExact, parseUnitsExact } from "@stunks/utils";
import { useCanTransact } from "@/components/wallet";
import {
  decimalsChanged,
  nativePrincipalRequired,
  supportsProtectedBuySequence,
} from "./launch-plan";
import type { LaunchPairAsset } from "./pair-assets";

/**
 * Protected launch form.
 *
 * This is intentionally a row editor rather than a textarea: every protected wallet
 * can have its own exact buy amount, and the total is visible before signing. Rows
 * become exemption declarations in the launch transaction; protected buy requests are
 * an explicit opt-in, sent only after receipt + deployed-code verification, and still
 * require one wallet confirmation per recipient.
 */

interface LaunchFormProps {
  readonly factory: Address;
  readonly router: Address;
  readonly launchFee: string;
  readonly maxCreatorTaxBps: number;
  readonly snipeTaxStartBps: number;
  readonly snipeTaxSeconds: number;
  readonly launchConfigId: string;
  /** Candidates were verified by the server against live factory approval. */
  readonly pairAssets: readonly LaunchPairAsset[];
}

interface WalletBuyRow {
  readonly id: string;
  readonly address: string;
  readonly amount: string;
}

interface ParsedWalletBuyRow extends WalletBuyRow {
  readonly amountIn: bigint | null;
}

function createWalletRow(id: number, amount = ""): WalletBuyRow {
  return { id: `wallet-${id}`, address: "", amount };
}

function parseQuoteAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (trimmed === "") return 0n;
  try {
    return parseUnitsExact(trimmed, decimals);
  } catch {
    return null;
  }
}

export function LaunchForm(props: LaunchFormProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const canTransact = useCanTransact();

  const nativePair = props.pairAssets.find((pair) => pair.native) ?? null;
  const [selectedPairAddress, setSelectedPairAddress] = useState<Address>(
    nativePair?.address ?? NATIVE_PAIR_TOKEN,
  );
  const selectedPair =
    props.pairAssets.find(
      (pair) => pair.address.toLowerCase() === selectedPairAddress.toLowerCase(),
    ) ?? nativePair;

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [description, setDescription] = useState("");
  const [creatorTaxPercent, setCreatorTaxPercent] = useState("2");
  const [devBuyAmount, setDevBuyAmount] = useState("0.01");
  const [walletRows, setWalletRows] = useState<WalletBuyRow[]>([createWalletRow(0, "0.01")]);
  const [nextWalletRowId, setNextWalletRowId] = useState(1);
  const [bundleEnabled, setBundleEnabled] = useState(false);
  const [tx, setTx] = useState<TxState>({ phase: "Idle" });
  const [bundle, setBundle] = useState<BundleUiState>({
    running: false,
    results: [],
    error: null,
    note: null,
  });

  const activeWalletRows = useMemo(
    () => walletRows.filter((row) => row.address.trim() !== ""),
    [walletRows],
  );
  const whitelistEntries = useMemo(
    () => activeWalletRows.map((row) => row.address.trim()),
    [activeWalletRows],
  );

  const exemptions = useMemo(
    () =>
      address
        ? validateSnipeExemptions({ addresses: whitelistEntries, deployer: address })
        : null,
    [whitelistEntries, address],
  );

  const parsedWalletRows = useMemo<readonly ParsedWalletBuyRow[]>(
    () =>
      activeWalletRows.map((row) => ({
        ...row,
        amountIn: selectedPair
          ? parseQuoteAmount(row.amount, selectedPair.decimals)
          : null,
      })),
    [activeWalletRows, selectedPair],
  );

  const bundleAmountInvalid =
    bundleEnabled &&
    selectedPair?.native === true &&
    (parsedWalletRows.length === 0 ||
      parsedWalletRows.some((row) => row.amountIn === null || row.amountIn <= 0n));

  const bundleRecipients = useMemo<readonly BundleRecipient[]>(
    () =>
      parsedWalletRows
        .filter((row): row is ParsedWalletBuyRow & { amountIn: bigint } =>
          row.amountIn !== null && row.amountIn > 0n,
        )
        .map((row) => ({ address: row.address.trim() as Address, amountIn: row.amountIn })),
    [parsedWalletRows],
  );

  const bundleTotal = useMemo(
    () => bundleRecipients.reduce((total, row) => total + row.amountIn, 0n),
    [bundleRecipients],
  );

  const parsedDevBuy = useMemo(
    () => (selectedPair ? parseQuoteAmount(devBuyAmount, selectedPair.decimals) : null),
    [devBuyAmount, selectedPair],
  );

  const isNativePair = selectedPair?.native === true;
  const shouldSendProtectedBuys =
    bundleEnabled && supportsProtectedBuySequence(isNativePair) && bundleRecipients.length > 0;
  const nativePrincipalBeforeGas = useMemo(
    () =>
      nativePrincipalRequired({
        launchFee: BigInt(props.launchFee),
        developerBuy: isNativePair ? (parsedDevBuy ?? 0n) : 0n,
        protectedBuyTotal: shouldSendProtectedBuys ? bundleTotal : 0n,
      }),
    [props.launchFee, isNativePair, parsedDevBuy, shouldSendProtectedBuys, bundleTotal],
  );

  const busy =
    tx.phase === "Quoting" ||
    tx.phase === "AwaitingWallet" ||
    tx.phase === "Pending" ||
    bundle.running;

  function updateWalletRow(id: string, patch: Partial<Pick<WalletBuyRow, "address" | "amount">>) {
    setWalletRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addWalletRow() {
    if (walletRows.length >= MAX_DECLARABLE_SNIPE_EXEMPTIONS) return;
    setWalletRows((rows) => [
      ...rows,
      createWalletRow(nextWalletRowId, isNativePair ? "0.01" : ""),
    ]);
    setNextWalletRowId((value) => value + 1);
  }

  function removeWalletRow(id: string) {
    setWalletRows((rows) => rows.filter((row) => row.id !== id));
  }

  function changePair(addressValue: string) {
    const nextPair = props.pairAssets.find(
      (pair) => pair.address.toLowerCase() === addressValue.toLowerCase(),
    );
    if (!nextPair) return;

    setSelectedPairAddress(nextPair.address);
    // Never reinterpret a human-entered ETH number as stock-token base units.
    setDevBuyAmount("0");
    setWalletRows((rows) => rows.map((row) => ({ ...row, amount: "" })));
    if (!nextPair.native) setBundleEnabled(false);
  }

  /**
   * Execute native whitelist buys only after a confirmed launch receipt supplies the
   * real curve address and that address proves it has code. ERC-20 bundles are
   * deliberately refused here: their exact curve allowance cannot be approved before
   * the curve exists, and an after-launch approval costs a confirmation inside the very
   * short protection window.
   */
  async function runBundle(
    receipt: { logs: readonly unknown[] },
    launchHash: `0x${string}`,
    recipients: readonly BundleRecipient[],
    effectiveExemptAddresses: readonly Address[],
  ): Promise<void> {
    if (!publicClient || !walletClient || !address) return;

    setBundle({ running: true, results: [], error: null, note: "Locating the curve…" });

    try {
      const logs = receipt.logs as {
        address: Address;
        topics: readonly `0x${string}`[];
        data: `0x${string}`;
      }[];

      const provisional = confirmedLaunchFromReceipt({
        logs,
        transactionHash: launchHash,
        factory: props.factory,
        curveHasCode: false,
      });

      if (!provisional) {
        setBundle({
          running: false,
          results: [],
          error:
            "The launch succeeded but its curve address could not be read from the receipt, " +
            "so no bundle buys were sent. Nothing was spent beyond the launch itself.",
          note: null,
        });
        return;
      }

      if (provisional.pairToken.toLowerCase() !== NATIVE_PAIR_TOKEN.toLowerCase()) {
        setBundle({
          running: false,
          results: [],
          error:
            "Protected buy requests are currently native-ETH only. The selected ERC-20 " +
            "pair needs a new curve allowance after launch, so pretending it can land inside " +
            "the protection window would be dishonest.",
          note: null,
        });
        return;
      }

      const code = await publicClient.getCode({ address: provisional.curve });
      if (code === undefined || code === "0x") {
        setBundle({
          running: false,
          results: [],
          error:
            "The curve contract is not visible on-chain yet, so no bundle buys were sent. " +
            "A buy to an address with no code would not revert and the funds would be lost.",
          note: null,
        });
        return;
      }

      const launch = { ...provisional, curveHasCode: true };
      const state = await readCurveState(publicClient, launch.curve);
      const planned = planBundle({
        recipients,
        pricingQuoteReserve: state.pricingQuoteReserve,
        tokenReserve: state.tokenReserve,
        reservedTokens: state.reservedTokens,
        feeBps: state.feeBps,
        creatorTaxBps: state.creatorTaxBps,
        slippageBps: 300,
        // Includes the deployer as an effective exemption even when Pons omitted it
        // from the declared list because it is auto-exempt by protocol.
        exemptAddresses: effectiveExemptAddresses,
      });

      if (!planned.ok) {
        setBundle({ running: false, results: [], error: planned.message, note: null });
        return;
      }

      const executable = buildBundleTransactions(planned.plan, launch);
      const block = await publicClient.getBlock();
      const fees = bundleGasCeiling(
        block.baseFeePerGas ?? 1_000_000_000n,
        1_000_000_000n,
      );

      setBundle({
        running: true,
        results: [],
        error: null,
        note: `Requesting ${executable.transactions.length} wallet confirmations for protected buys…`,
      });

      const hashes: { recipient: Address; hash: `0x${string}` | null; error?: string }[] = [];
      for (const transaction of executable.transactions) {
        try {
          const bundleHash = await walletClient.sendTransaction({
            to: transaction.to,
            data: transaction.data,
            value: transaction.value,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          });
          hashes.push({ recipient: transaction.recipient, hash: bundleHash });
        } catch (error) {
          hashes.push({
            recipient: transaction.recipient,
            hash: null,
            error: classifyTxError(error).message,
          });
        }
      }

      setBundle({
        running: true,
        results: hashes.map((entry) => ({
          recipient: entry.recipient,
          hash: entry.hash,
          status: entry.hash ? ("pending" as const) : ("failed" as const),
          detail: entry.error ?? null,
        })),
        error: null,
        note: "Waiting for confirmations…",
      });

      const results: BundleResult[] = [];
      for (const entry of hashes) {
        if (!entry.hash) {
          results.push({
            recipient: entry.recipient,
            hash: null,
            status: "failed",
            detail: entry.error ?? null,
          });
          continue;
        }
        try {
          const bundleReceipt = await publicClient.waitForTransactionReceipt({
            hash: entry.hash,
            pollingInterval: 100,
          });
          results.push({
            recipient: entry.recipient,
            hash: entry.hash,
            status: bundleReceipt.status === "success" ? "success" : "reverted",
            detail:
              bundleReceipt.status === "success"
                ? null
                : "Mined but reverted, most likely on the minimum-out bound. Nothing was traded.",
          });
        } catch {
          results.push({
            recipient: entry.recipient,
            hash: entry.hash,
            status: "unknown",
            detail:
              "The receipt could not be retrieved. The transaction may still confirm — " +
              "check the hash before resending.",
          });
        }
      }

      setBundle({ running: false, results, error: null, note: null });
    } catch (error) {
      setBundle({
        running: false,
        results: [],
        error: classifyTxError(error).message,
        note: null,
      });
    }
  }

  async function submit(): Promise<void> {
    if (!publicClient || !walletClient || !address || !selectedPair) return;

    setTx({ phase: "Quoting", message: "Reading live pair metadata and launch terms…" });

    try {
      let signingDecimals = selectedPair.decimals;
      if (!selectedPair.native) {
        const decimalsRead = await publicClient.readContract({
          address: selectedPair.address,
          abi: erc20Abi,
          functionName: "decimals",
        });
        const liveDecimals = decimalsRead as number;
        if (!Number.isInteger(liveDecimals) || liveDecimals < 0 || liveDecimals > 255) {
          setTx({
            phase: "Failed",
            message: "The selected ERC-20 returned an invalid decimal scale. Launching is blocked.",
            errorCode: "REVERTED",
          });
          return;
        }
        if (decimalsChanged(selectedPair.decimals, liveDecimals)) {
          setTx({
            phase: "Failed",
            message:
              "This pair's decimal scale changed since the page opened. Review every amount, " +
              "reload the page, and enter the values again before signing.",
            errorCode: "REVERTED",
          });
          return;
        }
        signingDecimals = liveDecimals;
      }

      const signingDevBuy = parseQuoteAmount(devBuyAmount, signingDecimals);
      if (signingDevBuy === null) {
        setTx({
          phase: "Failed",
          message: `Enter a valid ${selectedPair.symbol} amount for the developer buy.`,
          errorCode: "REVERTED",
        });
        return;
      }

      if (bundleAmountInvalid) {
        setTx({
          phase: "Failed",
          message:
            "Every protected wallet needs a valid amount greater than zero. Disable the " +
            "post-launch sequence if you only want exemptions.",
          errorCode: "REVERTED",
        });
        return;
      }

      const requiredNativeBeforeGas = nativePrincipalRequired({
        launchFee: BigInt(props.launchFee),
        developerBuy: selectedPair.native ? signingDevBuy : 0n,
        protectedBuyTotal: shouldSendProtectedBuys ? bundleTotal : 0n,
      });
      const nativeBalance = await publicClient.getBalance({ address });
      if (nativeBalance < requiredNativeBeforeGas) {
        setTx({
          phase: "Failed",
          message:
            `Your wallet has ${formatUnitsExact(nativeBalance, 18)} ETH but needs at least ` +
            `${formatUnitsExact(requiredNativeBeforeGas, 18)} ETH before gas for this launch plan.`,
          errorCode: "INSUFFICIENT_BALANCE",
        });
        return;
      }

      if (!selectedPair.native && signingDevBuy > 0n) {
        const pairBalance = (await publicClient.readContract({
          address: selectedPair.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        })) as bigint;
        if (pairBalance < signingDevBuy) {
          setTx({
            phase: "Failed",
            message:
              `Your wallet has ${formatUnitsExact(pairBalance, signingDecimals)} ${selectedPair.symbol} ` +
              `but the developer buy needs ${formatUnitsExact(signingDevBuy, signingDecimals)} ${selectedPair.symbol}. ` +
              "No approval or launch was sent.",
            errorCode: "INSUFFICIENT_BALANCE",
          });
          return;
        }
      }

      // A percentage with two decimal places is exactly basis points, so the tax never
      // passes through a float.
      const creatorTaxBps = parseUnitsExact(creatorTaxPercent || "0", 2);
      // eslint-disable-next-line no-restricted-syntax -- bps is a bounded integer (0..1000), not an amount
      const taxBps = Number(creatorTaxBps);

      const build = () =>
        buildLaunchTransaction(publicClient, props.factory, props.router, {
          name,
          symbol,
          logo,
          description,
          creator: address,
          creatorTaxBps: taxBps,
          buybackEnabled: true,
          launchConfigId: BigInt(props.launchConfigId),
          pairToken: selectedPair.address,
          devBuyAmount: signingDevBuy,
          minTokensOut: 0n,
          whitelist: whitelistEntries,
        });

      const initial = await build();
      if (!initial.ok) {
        setTx({ phase: "Failed", message: initial.errors.join(" "), errorCode: "REVERTED" });
        return;
      }
      let launch = initial.launch;

      // ERC-20 pair launches pull the developer buy through the router. Exact approval
      // is visible, then launch economics are rebuilt. Balance was checked above, so an
      // approval cannot be spent before discovering an obviously unfundable buy.
      if (!selectedPair.native && signingDevBuy > 0n) {
        const approvalNeeded = await needsApproval({
          client: publicClient,
          token: selectedPair.address,
          owner: address,
          spender: props.router,
          amount: signingDevBuy,
        });
        if (approvalNeeded) {
          setTx({
            phase: "AwaitingWallet",
            message: `Approve exactly ${formatUnitsExact(signingDevBuy, signingDecimals)} ${selectedPair.symbol} for the Pons launch router.`,
          });
          const approvalHash = await walletClient.writeContract({
            address: selectedPair.address,
            abi: erc20Abi,
            functionName: "approve",
            args: [props.router, signingDevBuy],
          });
          setTx({ phase: "Pending", hash: approvalHash, message: "Waiting for approval…" });
          const approvalReceipt = await publicClient.waitForTransactionReceipt({
            hash: approvalHash,
            pollingInterval: 100,
          });
          if (approvalReceipt.status !== "success") {
            setTx({
              phase: "Failed",
              hash: approvalHash,
              message: "The ERC-20 approval was mined but reverted. No launch was sent.",
              errorCode: "REVERTED",
            });
            return;
          }
        }

        const refreshed = await build();
        if (!refreshed.ok) {
          setTx({
            phase: "Failed",
            message: refreshed.errors.join(" "),
            errorCode: "REVERTED",
          });
          return;
        }
        launch = refreshed.launch;
      }

      // A final eth_call catches an allowance/balance/economics failure after any
      // approval has mined but before asking the user for the launch signature.
      try {
        await publicClient.call({
          account: address,
          to: launch.to,
          data: launch.data,
          value: launch.value,
        });
      } catch (error) {
        const classified = classifyTxError(error);
        setTx({
          phase: "Failed",
          message:
            "Launch simulation failed after the latest checks. No launch signature was requested. " +
            classified.message,
          errorCode: classified.code,
        });
        return;
      }

      setTx({
        phase: "AwaitingWallet",
        message: selectedPair.native
          ? "Confirm in your wallet. The native value must match exactly."
          : "Confirm the launch in your wallet. Only the native launch fee is sent as value.",
      });

      const hash = await walletClient.sendTransaction({
        to: launch.to,
        data: launch.data,
        value: launch.value,
      });

      setTx({ phase: "Pending", hash, message: "Waiting for the launch to mine…" });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
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

      setTx({
        phase: "Confirmed",
        hash,
        blockNumber: receipt.blockNumber,
        message: "Launched on-chain. It will appear in STUNKS once the indexer reaches this block.",
      });

      if (shouldSendProtectedBuys) {
        // Deployer is effectively exempt even when validateSnipeExemptions removes it
        // from the declared array, so include it in planner membership checks.
        await runBundle(receipt, hash, bundleRecipients, [...launch.whitelist, address]);
      }
    } catch (error) {
      const classified = classifyTxError(error);
      setTx({
        phase: classified.code === "WALLET_REJECTED" ? "Rejected" : "Failed",
        message: classified.message,
        errorCode: classified.code,
      });
    }
  }

  if (!selectedPair) {
    return (
      <div className="error">
        <p style={{ color: "var(--text)", margin: 0 }}>
          No current Pons pair asset is available. Launching is disabled rather than guessing
          a token address.
        </p>
      </div>
    );
  }

  return (
    <div className="stack launch-form launch-form-simple">
      <section className="panel pad launch-section">
        <h2>Token</h2>
        <div className="launch-field-grid">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} />
          </label>
          <label className="field">
            <span>Symbol</span>
            <input
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              maxLength={16}
            />
          </label>
        </div>
        <label className="field">
          <span>Image URI</span>
          <input
            value={logo}
            onChange={(event) => setLogo(event.target.value)}
            placeholder="ipfs://…"
          />
          <small>Prefer ipfs:// so your on-chain metadata does not depend on one gateway.</small>
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={512}
            rows={3}
          />
        </label>
      </section>

      <section className="panel pad launch-section">
        <h2>Pair & opening buy</h2>
        <div className="launch-field-grid">
          <label className="field">
            <span>Launch pair</span>
            <select
              value={selectedPair.address}
              onChange={(event) => changePair(event.target.value)}
              disabled={busy}
            >
              {props.pairAssets.map((pair) => (
                <option key={pair.address} value={pair.address}>
                  {pair.symbol} — {pair.name}{pair.native ? " (native)" : ""}
                </option>
              ))}
            </select>
            <small>
              ERC-20 options are re-checked against factory approval when this page loads. ETH follows Pons&apos;s native pair path.
            </small>
          </label>
          <label className="field">
            <span>Developer buy ({selectedPair.symbol})</span>
            <input
              value={devBuyAmount}
              onChange={(event) => setDevBuyAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0"
              disabled={busy}
            />
            <small>
              {selectedPair.native
                ? "Atomic with the launch. It cannot be front-run."
                : "Uses an exact ERC-20 approval to the launch router before your launch prompt."}
            </small>
          </label>
        </div>

        <div className="pair-status-card">
          <span className={selectedPair.native ? "badge" : "badge ok"}>
            {selectedPair.native ? "Native Pons pair" : "Factory approved"}
          </span>
          <div>
            <strong>{selectedPair.name}</strong>
            <p>
              {selectedPair.decimals} decimals ·{" "}
              {selectedPair.historicalLaunchCount > 0
                ? `seen in ${selectedPair.historicalLaunchCount.toLocaleString("en-US")} indexed Pons launches`
                : "native Pons pair"}
            </p>
          </div>
        </div>

        <label className="field">
          <span>Creator tax (%)</span>
          <input
            value={creatorTaxPercent}
            onChange={(event) => setCreatorTaxPercent(event.target.value)}
            inputMode="decimal"
            disabled={busy}
          />
          <small>
            Paid to your creator address on each trade. Current Pons ceiling: {props.maxCreatorTaxBps / 100}%.
          </small>
        </label>
        <p className="hint">
          Native launch fee: <span className="mono">{formatUnitsExact(BigInt(props.launchFee), 18)} ETH</span>.{" "}
          STUNKS adds 0 fee.
        </p>
        {isNativePair && (
          <div className="native-funding-card">
            <span>Required ETH before gas</span>
            <strong className="mono">{formatUnitsExact(nativePrincipalBeforeGas, 18)} ETH</strong>
            <small>
              Launch fee {formatUnitsExact(BigInt(props.launchFee), 18)} ETH + developer buy{" "}
              {formatUnitsExact(parsedDevBuy ?? 0n, 18)} ETH + protected buy requests{" "}
              {formatUnitsExact(shouldSendProtectedBuys ? bundleTotal : 0n, 18)} ETH. Network gas is additional.
            </small>
          </div>
        )}
      </section>

      <section className="panel pad launch-section protected-wallets-section">
        <div className="protected-wallets-heading">
          <div>
            <h2>Protected wallets</h2>
            <p className="hint">
              Add one recipient per row. A wallet in this list is exempt from the launch
              anti-snipe tax; its amount is used only when protected buy requests are queued.
            </p>
          </div>
          <span className="badge">{exemptions?.slotsUsed ?? 0} / {MAX_DECLARABLE_SNIPE_EXEMPTIONS}</span>
        </div>

        <label className="bundle-toggle">
          <input
            type="checkbox"
            checked={bundleEnabled}
            onChange={(event) => setBundleEnabled(event.target.checked)}
            disabled={!isNativePair || activeWalletRows.length === 0 || busy}
          />
          <span>
            <strong>Queue protected buy requests after launch</strong>
            <small>
              {isNativePair
                ? `Your wallet will request one confirmation per row after the launch receipt. These sends are sequential, non-atomic, and may not all land inside the ${props.snipeTaxSeconds}s window.`
                : "Unavailable for this ERC-20 pair: the new curve needs an approval only available after launch."}
            </small>
          </span>
        </label>

        <div className="wallet-row-editor" role="group" aria-label="Protected wallet buys">
          <div className="wallet-row-editor-head" aria-hidden="true">
            <span>Recipient wallet</span>
            <span>Buy amount ({selectedPair.symbol})</span>
            <span />
          </div>
          {walletRows.map((row, index) => {
            const parsed = parsedWalletRows.find((item) => item.id === row.id);
            const invalidAmount =
              bundleEnabled &&
              isNativePair &&
              row.address.trim() !== "" &&
              (parsed?.amountIn === null || (parsed?.amountIn ?? 0n) <= 0n);
            return (
              <div className="wallet-buy-row" key={row.id}>
                <label>
                  <span className="sr-only">Recipient wallet {index + 1}</span>
                  <input
                    value={row.address}
                    onChange={(event) => updateWalletRow(row.id, { address: event.target.value })}
                    placeholder="0x wallet address"
                    className="mono"
                    disabled={busy}
                  />
                </label>
                <label>
                  <span className="sr-only">Buy amount for wallet {index + 1}</span>
                  <input
                    value={row.amount}
                    onChange={(event) => updateWalletRow(row.id, { amount: event.target.value })}
                    inputMode="decimal"
                    placeholder={bundleEnabled && isNativePair ? "0.01" : "Optional"}
                    disabled={busy || !bundleEnabled || !isNativePair}
                    aria-invalid={invalidAmount}
                  />
                </label>
                <button
                  type="button"
                  className="row-remove"
                  onClick={() => removeWalletRow(row.id)}
                  disabled={busy}
                  aria-label={`Remove wallet row ${index + 1}`}
                  title="Remove wallet"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          className="btn btn-add-wallet"
          onClick={addWalletRow}
          disabled={busy || walletRows.length >= MAX_DECLARABLE_SNIPE_EXEMPTIONS}
        >
          + Add wallet
        </button>

        {bundleEnabled && isNativePair && (
          <div className={bundleAmountInvalid ? "bundle-total invalid" : "bundle-total"}>
            <span>Total protected buy requests</span>
            <strong className="mono">
              {formatUnitsExact(bundleTotal, selectedPair.decimals)} {selectedPair.symbol}
            </strong>
            <small>
              Each row needs its own wallet confirmation after launch. This total is added
              to developer buy and launch fee; native gas is separate.
            </small>
          </div>
        )}

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

        <details className="launch-disclosures">
          <summary>Read the whitelist rules before launch</summary>
          <ul className="disclosures">
            {EXEMPTION_DISCLOSURES.map((line) => (
              <li key={line}>{line}</li>
            ))}
            <li>
              At more than roughly 8 native bundle buys, later transactions may confirm
              after the short anti-snipe window. They remain exempt but may buy at a moved price.
            </li>
          </ul>
        </details>
      </section>

      {(bundle.running || bundle.results.length > 0 || bundle.error !== null) && (
        <section className="panel pad launch-section">
          <h2>Protected buy results</h2>
          {bundle.note !== null && <p className="hint">{bundle.note}</p>}
          {bundle.error !== null && <p className="hint error-text">{bundle.error}</p>}
          {bundle.results.length > 0 && (
            <table className="compact">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {bundle.results.map((result) => (
                  <tr key={result.recipient}>
                    <td className="mono">{result.recipient}</td>
                    <td>
                      <span
                        className={`badge ${
                          result.status === "success"
                            ? "ok"
                            : result.status === "pending" || result.status === "unknown"
                              ? "warn"
                              : "bad"
                        }`}
                      >
                        {result.status}
                      </span>
                    </td>
                    <td className="hint">
                      {result.detail ??
                        (result.hash !== null ? <span className="mono">{result.hash}</span> : "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="panel pad launch-section launch-submit-section">
        <h2>Launch</h2>
        {!canTransact.ok && <p className="hint error-text">{canTransact.reason}</p>}
        <button
          type="button"
          className="btn btn-primary launch-submit"
          disabled={
            !canTransact.ok ||
            busy ||
            (exemptions?.errors.length ?? 0) > 0 ||
            parsedDevBuy === null ||
            bundleAmountInvalid ||
            name.trim() === "" ||
            symbol.trim() === "" ||
            logo.trim() === ""
          }
          onClick={() => void submit()}
        >
          {busy ? "Working…" : `Launch with ${selectedPair.symbol}`}
        </button>
        <TxStatus state={tx} />
      </section>
    </div>
  );
}

/** Signed, mined, and indexed are separate states and must stay separate in UI. */
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
          The launch is mined. STUNKS shows it after the indexer reaches this block.
        </p>
      )}
    </div>
  );
}

interface BundleResult {
  readonly recipient: string;
  readonly hash: string | null;
  readonly status: "pending" | "success" | "reverted" | "failed" | "unknown";
  readonly detail: string | null;
}

interface BundleUiState {
  readonly running: boolean;
  readonly results: readonly BundleResult[];
  readonly error: string | null;
  readonly note: string | null;
}
