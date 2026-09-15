/**
 * PonsV2BondingCurve ABI fragments.
 *
 * PROVENANCE — this is the most important note in the package.
 *
 * The published `PonsV2BondingCurve.sol` does NOT describe the deployed contract.
 * The deployed bytecode contains an entire anti-snipe subsystem that appears
 * nowhere in that source file. All five of those functions were recovered by
 * scanning deployed curve bytecode for 4-byte selectors and then exercising them
 * against mainnet:
 *
 *   0x31ff7f22  exemptFromSnipeTax(address)      <- factory calls it; absent from source
 *   0x50e25ac2  snipeTaxStartBps()               <- absent from source
 *   0x6783774b  snipeTaxSeconds()                <- absent from source
 *   0xbf56b371  launchedAt()                     <- absent from source
 *   0xd44bdfe7  snipeTaxExempt(address)          <- absent from source
 *   0xd7e1ef39  currentSnipeTaxBps(address)      <- absent from source
 *
 * Equally important is what is NOT here. There is no quote function on the curve:
 *
 *   0x4beb394c  quoteBuy(uint256)     CONFIRMED ABSENT
 *   0xa64190c4  quoteSell(uint256)    CONFIRMED ABSENT
 *
 * The PRD assumed those existed. They do not, which is why this package computes
 * quotes locally and confirms them by simulation (see ../curve/quote.ts).
 */

export const ponsV2CurveAbi = [
  // ── Trading ────────────────────────────────────────────────────────────────
  // Native-quote launches: quoteIn MUST equal msg.value.
  // ERC-20-quote launches: send no value; credit is the observed balance delta.
  {
    type: "function",
    name: "buy",
    stateMutability: "payable",
    inputs: [
      { name: "quoteIn", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "tokensOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokensIn", type: "uint256" },
      { name: "minQuoteOut", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "quoteOut", type: "uint256" }],
  },

  // ── Reserves ───────────────────────────────────────────────────────────────
  // getReserves() is the PRICING reserve and includes phantomQuote.
  // realQuoteReserve() is the GRADUATION-PROGRESS reserve and excludes it.
  // At launch these read 1.68 ETH and 0 respectively. Do not mix them up.
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "quoteReserve", type: "uint256" },
      { name: "tokenReserve", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "realQuoteReserve",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteReserve",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenReserve",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "trackedQuote",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "trackedTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },

  // ── Launch parameters (immutable per curve) ─────────────────────────────────
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "pairToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "phantomQuote",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "creatorTaxBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "graduationThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },

  // ── Graduation ─────────────────────────────────────────────────────────────
  // reservedTokens = supply * phantomQuote / (phantomQuote + graduationThreshold),
  // verified byte-exact on-chain. readyToGraduate() is sellableTokens() == 0.
  {
    type: "function",
    name: "reservedTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "sellableTokens",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "graduated",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "readyToGraduate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },

  // ── Anti-snipe subsystem: DEPLOYED BUT UNDOCUMENTED (see header) ───────────
  {
    type: "function",
    name: "launchedAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "snipeTaxStartBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "snipeTaxSeconds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "snipeTaxExempt",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  // Takes an address because the tax is evaluated PER RECIPIENT, not per sender.
  // Prefer this over recomputing the bit-shift decay locally.
  {
    type: "function",
    name: "currentSnipeTaxBps",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ type: "uint256" }],
  },

  // ── Events ─────────────────────────────────────────────────────────────────
  // Note the names: CurveBuy / CurveSell. There is no `Buy` or `Sell` event,
  // contrary to what the PRD assumed.
  {
    type: "event",
    name: "CurveBuy",
    inputs: [
      { name: "buyer", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "quoteIn", type: "uint256", indexed: false },
      { name: "tokensOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "tax", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CurveSell",
    inputs: [
      { name: "seller", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "tokensIn", type: "uint256", indexed: false },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "tax", type: "uint256", indexed: false },
    ],
  },
  // Emitted when a buy is clamped to reservedTokens and the surplus is returned.
  // Any UI that reports "you received exactly X" must account for this.
  {
    type: "event",
    name: "CurveBuyRefunded",
    inputs: [
      { name: "buyer", type: "address", indexed: true },
      { name: "refund", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeesSwept",
    inputs: [
      { name: "protocolAmount", type: "uint256", indexed: false },
      { name: "buybackAmount", type: "uint256", indexed: false },
      { name: "creatorAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BuybackLocked",
    inputs: [
      { name: "quoteSpent", type: "uint256", indexed: false },
      { name: "tokensLocked", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CurveCompleted",
    inputs: [
      { name: "recipient", type: "address", indexed: false },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "tokenOut", type: "uint256", indexed: false },
    ],
  },
  // The signal that a token is stuck in `Swept` with no pool.
  {
    type: "event",
    name: "AutoGraduationFailed",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "gasRemaining", type: "uint256", indexed: false },
    ],
  },
] as const;
