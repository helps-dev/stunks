import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { KNOWN_RPC_ENDPOINTS, ROBINHOOD_CHAIN_ID, robinhoodChain } from "@stunks/config";

/**
 * Wallet configuration.
 *
 * Deliberately narrow: `injected` only. STUNKS is non-custodial, so the wallet holds
 * the keys and STUNKS never sees them. Adding WalletConnect or a hosted signer later
 * is additive; starting with the smallest surface keeps that promise easy to audit.
 *
 * Robinhood Chain is the ONLY chain configured. wagmi will refuse to build a
 * transaction for a chain it does not know, which is a useful second line of defence
 * behind the explicit chain guard in the UI.
 */

function rpcEndpoints(): string[] {
  const configured = process.env.NEXT_PUBLIC_RPC_ENDPOINTS;
  if (configured) {
    return configured
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [KNOWN_RPC_ENDPOINTS.drpc, KNOWN_RPC_ENDPOINTS.ordofi];
}

export function createWagmiConfig() {
  const endpoints = rpcEndpoints();
  const primary = endpoints[0] ?? KNOWN_RPC_ENDPOINTS.drpc;

  return createConfig({
    chains: [robinhoodChain],
    connectors: [injected({ shimDisconnect: true })],
    transports: {
      // 100 ms blocks mean viem's 4-second default polling would be slower than the
      // entire anti-snipe window a launch bundle has to land inside.
      [ROBINHOOD_CHAIN_ID]: http(primary, {
        retryCount: 2,
        retryDelay: 400,
        timeout: 20_000,
      }),
    },
    ssr: true,
  });
}

export { ROBINHOOD_CHAIN_ID, robinhoodChain };
