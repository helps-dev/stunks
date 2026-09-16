import { getChainContracts, KNOWN_RPC_ENDPOINTS, ROBINHOOD_CHAIN_ID } from "@stunks/config";
import { createReadClient } from "@stunks/web3";
import {
  readFactoryParameters,
  readLaunchConfigs,
  resolvePonsAddresses,
} from "@stunks/pons";
import { ConnectWallet } from "@/components/wallet";
import { LaunchForm } from "./launch-form";

/**
 * Launch page.
 *
 * Every parameter the form needs is read from the chain on each request, never cached
 * as a constant. `launchFee`, `maxCreatorTaxBps`, `snipeTaxStartBps` and
 * `snipeTaxSeconds` are all owner-mutable, and a stale launch fee produces a
 * guaranteed revert because Pons compares `msg.value` with `!=` rather than `<`.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

function endpoints(): string[] {
  const configured = process.env.NEXT_PUBLIC_RPC_ENDPOINTS ?? process.env.RPC_ENDPOINTS;
  if (configured) {
    return configured
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [KNOWN_RPC_ENDPOINTS.drpc, KNOWN_RPC_ENDPOINTS.ordofi];
}

export default async function LaunchPage() {
  const { client, assertChain } = createReadClient(endpoints());
  const factory = getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2Factory;

  let terms: {
    router: string;
    launchFee: string;
    maxCreatorTaxBps: number;
    snipeTaxStartBps: number;
    snipeTaxSeconds: number;
    launchConfigId: string;
    launchEnabled: boolean;
  } | null = null;
  let loadError: string | null = null;

  try {
    await assertChain();
    const [addresses, params, configs] = await Promise.all([
      resolvePonsAddresses(client, factory),
      readFactoryParameters(client, factory),
      readLaunchConfigs(client, factory),
    ]);

    const enabled = configs.find((config) => config.enabled) ?? configs[0];
    if (!enabled) throw new Error("Pons reports no launch configuration.");

    terms = {
      router: addresses.launchAndBuyRouter,
      launchFee: params.launchFee.toString(),
      // eslint-disable-next-line no-restricted-syntax -- bps and a seconds window are small integers crossing a server/client boundary, not amounts
      maxCreatorTaxBps: Number(params.maxCreatorTaxBps),
      // eslint-disable-next-line no-restricted-syntax -- see above
      snipeTaxStartBps: Number(params.snipeTaxStartBps),
      // eslint-disable-next-line no-restricted-syntax -- see above
      snipeTaxSeconds: Number(params.snipeTaxSeconds),
      launchConfigId: enabled.id.toString(),
      launchEnabled: params.launchEnabled,
    };
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <main className="launch-page">
      <section className="launch-page-hero">
        <p className="page-kicker">Create on Pons V2</p>
        <h1>
          Launch with an
          <span className="text-brand"> honest edge.</span>
        </h1>
        <p>
          Set token terms, disclose creator tax, and optionally protect verified recipients
          from the launch-block anti-snipe tax. STUNKS does not take custody or add a
          platform fee.
        </p>
      </section>

      <div className="launch-page-layout">
        <div>
          {loadError !== null || terms === null ? (
            <section className="error">
              <p style={{ color: "var(--text)", marginBottom: 8 }}>
                <strong>Live launch terms unavailable</strong>
              </p>
              <p className="hint">
                Launch terms could not be read from the chain, so this form is disabled
                rather than showing values that might be wrong.
              </p>
              <p className="hint mono" style={{ marginTop: 10 }}>
                {loadError}
              </p>
            </section>
          ) : !terms.launchEnabled ? (
            <section className="error">
              <p style={{ color: "var(--text)", marginBottom: 8 }}>
                <strong>Launches disabled by Pons</strong>
              </p>
              <p className="hint">
                Pons currently has launches disabled at the protocol level. Attempting a
                launch would revert, so STUNKS will not show an actionable form.
              </p>
            </section>
          ) : (
            <LaunchForm
              factory={factory}
              router={terms.router as `0x${string}`}
              launchFee={terms.launchFee}
              maxCreatorTaxBps={terms.maxCreatorTaxBps}
              snipeTaxStartBps={terms.snipeTaxStartBps}
              snipeTaxSeconds={terms.snipeTaxSeconds}
              launchConfigId={terms.launchConfigId}
            />
          )}
        </div>

        <aside className="panel launch-sidecard">
          <p className="page-kicker">Your wallet</p>
          <h3>Sign from your own wallet</h3>
          <ConnectWallet />
          <div className="launch-side-divider" />
          <div className="trust-list">
            <div className="trust-row">
              <span className="trust-row-icon">0</span>
              <div>
                <strong>STUNKS fee</strong>
                <p>Zero. The live Pons launch fee and network gas are disclosed in the form.</p>
              </div>
            </div>
            <div className="trust-row">
              <span className="trust-row-icon">✓</span>
              <div>
                <strong>Exact-value safety</strong>
                <p>Terms are refreshed from chain before your wallet is asked to sign.</p>
              </div>
            </div>
            <div className="trust-row">
              <span className="trust-row-icon">◈</span>
              <div>
                <strong>No private keys</strong>
                <p>STUNKS cannot hold or move funds from your wallet.</p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
