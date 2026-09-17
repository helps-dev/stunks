import {
  getChainContracts,
  KNOWN_RPC_ENDPOINTS,
  ROBINHOOD_CHAIN_ID,
} from "@stunks/config";
import { createReadClient } from "@stunks/web3";
import {
  erc20Abi,
  NATIVE_PAIR_TOKEN,
  readFactoryParameters,
  readLaunchConfigs,
  readPairTokenApproved,
  readPairTokenEconomics,
  resolvePonsAddresses,
} from "@stunks/pons";
import { isAddress, type Address, type PublicClient } from "viem";
import { ConnectWallet } from "@/components/wallet";
import { launchPairCandidates } from "@/lib/queries";
import { LaunchForm } from "./launch-form";
import type { LaunchPairAsset } from "./pair-assets";

/**
 * Launch page.
 *
 * Mutable launch terms and selectable pair assets are read from chain each request.
 * Historical launches only discover candidates; `approvedPairTokens()` plus current
 * ERC-20 metadata/economics decide whether an asset is actually offered in the form.
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

function isPairAsset(value: LaunchPairAsset | null): value is LaunchPairAsset {
  return value !== null;
}

/**
 * Pair approval is a mapping, not an enumerable factory list. Candidate addresses come
 * from already indexed real launches, then every candidate is independently checked
 * against the live factory before it reaches the user.
 */
async function resolveVerifiedPairAssets(
  client: PublicClient,
  factory: Address,
): Promise<readonly LaunchPairAsset[]> {
  const historical = await launchPairCandidates();
  const candidates = new Map<
    string,
    { address: Address; historicalLaunchCount: number }
  >();

  candidates.set(NATIVE_PAIR_TOKEN.toLowerCase(), {
    address: NATIVE_PAIR_TOKEN,
    historicalLaunchCount: 0,
  });

  for (const candidate of historical) {
    if (!isAddress(candidate.address)) continue;
    const address = candidate.address as Address;
    const key = address.toLowerCase();
    const existing = candidates.get(key);
    candidates.set(key, {
      address,
      historicalLaunchCount: Math.max(
        existing?.historicalLaunchCount ?? 0,
        candidate.launchCount,
      ),
    });
  }

  const verified = await Promise.all(
    [...candidates.values()].map(async (candidate): Promise<LaunchPairAsset | null> => {
      try {
        if (candidate.address.toLowerCase() === NATIVE_PAIR_TOKEN.toLowerCase()) {
          // ETH is Pons's zero-address special case. It is not an ERC-20 mapping
          // member, so approvedPairTokens(0) is false even though native launches are
          // supported and verified by the exact-value launch path.
          return {
            address: candidate.address,
            symbol: "ETH",
            name: "Native Ether",
            decimals: 18,
            native: true,
            historicalLaunchCount: candidate.historicalLaunchCount,
          };
        }

        const approved = await readPairTokenApproved(client, factory, candidate.address);
        if (!approved) return null;

        // Read current pair economics too. Approval alone says it is a mapping member;
        // readable economics confirms the factory can price the asset now.
        await readPairTokenEconomics(client, factory, candidate.address);

        const [name, symbol, decimals] = await Promise.all([
          client.readContract({
            address: candidate.address,
            abi: erc20Abi,
            functionName: "name",
          }),
          client.readContract({
            address: candidate.address,
            abi: erc20Abi,
            functionName: "symbol",
          }),
          client.readContract({
            address: candidate.address,
            abi: erc20Abi,
            functionName: "decimals",
          }),
        ]);

        const decimalCount = decimals as number;
        if (!Number.isInteger(decimalCount) || decimalCount < 0 || decimalCount > 255) {
          return null;
        }

        return {
          address: candidate.address,
          symbol: symbol as string,
          name: name as string,
          decimals: decimalCount,
          native: false,
          historicalLaunchCount: candidate.historicalLaunchCount,
        };
      } catch {
        // A historical candidate with unreadable current metadata/economics is not
        // safe to present. Omitting it is more honest than guessing its decimals/name.
        return null;
      }
    }),
  );

  return verified.filter(isPairAsset);
}

export default async function LaunchPage() {
  const { client, assertChain } = createReadClient(endpoints());
  const factory = getChainContracts(ROBINHOOD_CHAIN_ID).ponsV2Factory;

  let terms: {
    router: Address;
    launchFee: string;
    maxCreatorTaxBps: number;
    snipeTaxStartBps: number;
    snipeTaxSeconds: number;
    launchConfigId: string;
    launchEnabled: boolean;
  } | null = null;
  let pairAssets: readonly LaunchPairAsset[] = [];
  let loadError: string | null = null;

  try {
    await assertChain();
    const [addresses, params, configs, verifiedPairs] = await Promise.all([
      resolvePonsAddresses(client, factory),
      readFactoryParameters(client, factory),
      readLaunchConfigs(client, factory),
      resolveVerifiedPairAssets(client, factory),
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
    pairAssets = verifiedPairs;
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
          Pick a verified pair, set a developer buy, and add protected wallet rows with
          their own buy amounts. STUNKS does not take custody or add a platform fee.
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
                Launch terms or verified pair assets could not be read from chain, so this
                form is disabled rather than showing values that might be wrong.
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
              router={terms.router}
              launchFee={terms.launchFee}
              maxCreatorTaxBps={terms.maxCreatorTaxBps}
              snipeTaxStartBps={terms.snipeTaxStartBps}
              snipeTaxSeconds={terms.snipeTaxSeconds}
              launchConfigId={terms.launchConfigId}
              pairAssets={pairAssets}
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
                <p>
                  Zero. The live Pons launch fee and network gas are disclosed in the
                  form.
                </p>
              </div>
            </div>
            <div className="trust-row">
              <span className="trust-row-icon">✓</span>
              <div>
                <strong>Verified pair candidate</strong>
                <p>
                  ERC-20 choices are checked live by the factory; ETH follows Pons&apos;s
                  native path.
                </p>
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
