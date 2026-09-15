import { defineChain } from "viem";

/**
 * Robinhood Chain.
 *
 * Verified by direct RPC during the Phase 0 audit:
 *   eth_chainId          -> 0x1237 (4663)
 *   measured block time  -> 0.1013 s over a 10,000 block window
 *   blocks per day       -> ~852,912
 *
 * That block time is the single most consequential number in the whole project:
 * it makes the indexer backfill expensive, makes a 4-second RPC poll longer than
 * the entire anti-snipe window, and makes "next block" mean 100 ms.
 */

export const ROBINHOOD_CHAIN_ID = 4663 as const;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630 as const;

/** Measured, not documented. Used for block <-> time estimates. */
export const BLOCK_TIME_SECONDS = 0.1013;
export const BLOCKS_PER_DAY = 852_912;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    // Populated at runtime from RPC_ENDPOINTS. The default here is the official
    // endpoint, which is correct for production even though it was unreachable
    // from the audit machine (that network intercepts robinhood.com DNS).
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
  contracts: {
    multicall3: {
      // Canonical Multicall3, confirmed deployed on 4663 during the audit.
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
});

/**
 * Endpoints confirmed to answer eth_chainId with 4663 during the audit, with the
 * quirks each one imposes on the client.
 */
export const KNOWN_RPC_ENDPOINTS = {
  /** Official. Prefer in production. */
  official: "https://rpc.mainnet.chain.robinhood.com",
  /** Archive state available at block 1. Rejects wide eth_getLogs ranges. */
  drpc: "https://robinhood.drpc.org",
  /** Used by third-party Pons tooling. */
  ordofi: "https://rpc.ordofi.network",
  /**
   * ~2 req/s. Returns an HTML 403 page instead of a JSON-RPC error when
   * throttled, which is why the transport must treat non-JSON as a transport
   * failure rather than a chain answer.
   */
  nodeflare: "https://rpc.nodeflare.app/robinhood/public",
} as const;
