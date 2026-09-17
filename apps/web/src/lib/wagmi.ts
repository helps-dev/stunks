import { createConfig, fallback, http } from "wagmi";
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
  const configured = endpoints.length > 0 ? endpoints : [KNOWN_RPC_ENDPOINTS.drpc];

  /**
   * Failover, matching what the server already has.
   *
   * The server side runs every read through `RpcPool`, which tracks endpoint health,
   * cools a failing endpoint down and — importantly on this chain — treats a non-JSON
   * body as a transport failure rather than an answer, because a throttled endpoint
   * here returns an HTML 403 page instead of a JSON-RPC error.
   *
   * The browser got none of that: a single `http()` transport on whichever endpoint
   * happened to be first. That is backwards. This is the path where a user is asked to
   * sign, and where a failed read means either a quote that cannot be produced or a
   * receipt that cannot be confirmed — the two moments where an unavailable endpoint
   * is least acceptable.
   *
   * `fallback` ranks by latency and success rate and moves on when one stops answering.
   * `retryCount` stays low per endpoint on purpose: with a 3-second anti-snipe window,
   * moving to the next endpoint quickly beats waiting out a slow one.
   */
  const transport = fallback(
    configured.map((url) =>
      http(url, {
        retryCount: 1,
        retryDelay: 300,
        timeout: 12_000,
      }),
    ),
    {
      rank: {
        // Re-rank often enough to notice an endpoint degrading mid-session, rarely
        // enough not to spend the user's rate-limit budget measuring.
        interval: 30_000,
        sampleCount: 5,
      },
      retryCount: 1,
    },
  );

  return createConfig({
    chains: [robinhoodChain],
    connectors: [injected({ shimDisconnect: true })],
    transports: {
      // 100 ms blocks mean viem's 4-second default polling would be slower than the
      // entire anti-snipe window a launch bundle has to land inside.
      [ROBINHOOD_CHAIN_ID]: transport,
    },
    ssr: true,
  });
}

export { ROBINHOOD_CHAIN_ID, robinhoodChain };
