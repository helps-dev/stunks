import { createConfig, fallback, http } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { KNOWN_RPC_ENDPOINTS, ROBINHOOD_CHAIN_ID, robinhoodChain } from "@stunks/config";

/**
 * Wallet configuration.
 *
 * STUNKS is non-custodial: the wallet holds the keys, STUNKS never sees them, and it
 * never signs on anyone's behalf. Every connector here preserves that — none of them
 * is a hosted signer.
 *
 * WHAT IS OFFERED, AND WHY EACH
 *
 *   discovered wallets  Every browser extension that announces itself over EIP-6963.
 *                       wagmi finds them automatically, so a browser with ten wallets
 *                       installed offers ten. This is the important one, and it used
 *                       to be squandered: the UI took `connectors[0]` and connected to
 *                       whichever wagmi happened to list first, which on a machine
 *                       with many extensions is a coin toss and reported the result as
 *                       "Wallet connection failed".
 *   WalletConnect       Phone wallets, and desktop wallets without an extension.
 *                       Needs a project id; omitted entirely when there is none,
 *                       rather than offered and then failing on click.
 *   Coinbase Wallet     Its own SDK, which also covers the Smart Wallet — no
 *                       extension required.
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

  // Offered only when configured. A WalletConnect connector built without a project id
  // appears in the list and then fails the moment someone clicks it, which is worse
  // than not offering it: the user cannot tell a missing setting from a broken wallet.
  const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();

  return createConfig({
    chains: [robinhoodChain],
    // `injected` is listed once; wagmi adds one entry per EIP-6963 wallet the browser
    // announces, so this is a floor rather than the whole list.
    connectors: [
      injected({ shimDisconnect: true }),
      coinbaseWallet({ appName: "STUNKS.FUN", preference: "all" }),
      ...(projectId
        ? [
            walletConnect({
              projectId,
              showQrModal: true,
              metadata: {
                name: "STUNKS.FUN",
                description: "Token launchpad and trading on Robinhood Chain",
                url: process.env.NEXT_PUBLIC_APP_URL ?? "https://stunks.fun",
                icons: [],
              },
            }),
          ]
        : []),
    ],
    transports: {
      // 100 ms blocks mean viem's 4-second default polling would be slower than the
      // entire anti-snipe window a launch bundle has to land inside.
      [ROBINHOOD_CHAIN_ID]: transport,
    },
    ssr: true,
  });
}

export { ROBINHOOD_CHAIN_ID, robinhoodChain };
