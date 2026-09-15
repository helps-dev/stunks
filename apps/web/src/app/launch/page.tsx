import { getChainContracts, ROBINHOOD_CHAIN_ID } from "@stunks/config";
import { createReadClient } from "@stunks/web3";
import {
  readFactoryParameters,
  readLaunchConfigs,
  resolvePonsAddresses,
} from "@stunks/pons";
import { KNOWN_RPC_ENDPOINTS } from "@stunks/config";
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
    <main>
      <h1>Launch a token</h1>
      <p>
        Deployed through Pons V2 on Robinhood Chain. STUNKS never takes custody, and
        charges no fee of its own — the only cost is Pons&apos;s launch fee and gas.
      </p>

      <h2>Wallet</h2>
      <div className="panel pad">
        <ConnectWallet />
      </div>

      {loadError !== null || terms === null ? (
        <>
          <h2>Live terms unavailable</h2>
          <div className="error">
            <p style={{ color: "var(--text)" }}>
              Launch terms could not be read from the chain, so this form is disabled
              rather than showing values that might be wrong.
            </p>
            <p className="mono">{loadError}</p>
          </div>
        </>
      ) : !terms.launchEnabled ? (
        <>
          <h2>Launches disabled</h2>
          <div className="error">
            <p style={{ color: "var(--text)", margin: 0 }}>
              Pons currently has launches disabled at the protocol level. Nothing STUNKS
              can do will change that, and attempting a launch would revert.
            </p>
          </div>
        </>
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
    </main>
  );
}
