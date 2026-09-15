/**
 * PonsV2MemeHook fragments.
 *
 * The hook is also the protocol's `IPonsV2FeePolicy` implementation — there is no
 * separate fee-policy contract, and the factory has no `feePolicy()` getter. All
 * reads below were exercised against the deployed hook at
 * 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044.
 *
 * Live values at audit time: protocolFeeShareBps 3000, buybackBurnBps 5000,
 * hookFeeBps 100, maxInternalPriceImpactBps 300. None of them route value to
 * STUNKS, which is why platform revenue is reported as zero in V1.
 */

export const ponsV2MemeHookAbi = [
  {
    type: "function",
    name: "protocolFeeShareBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "buybackBurnBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "hookFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "maxInternalPriceImpactBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "protocolFeeRecipient",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "feeEscrow",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "feeSweepOperator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "currentFeePolicy",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "protocolFeeRecipient", type: "address" },
          { name: "protocolFeeShareBps", type: "uint16" },
          { name: "buybackBurnBps", type: "uint16" },
          { name: "hookFeeBps", type: "uint16" },
          { name: "maxInternalPriceImpactBps", type: "uint16" },
        ],
      },
    ],
  },

  // Joins a token to its Uniswap V4 poolId. Required to index graduated volume,
  // because post-graduation swaps are emitted by the V4 PoolManager singleton and
  // must be filtered by poolId rather than by token address.
  {
    type: "event",
    name: "PoolRegistered",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "memecoin", type: "address", indexed: false },
      { name: "quoteToken", type: "address", indexed: false },
      { name: "creator", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "HookFeeCollected",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "currency", type: "address", indexed: false },
      { name: "feeAmount", type: "uint256", indexed: false },
      { name: "taxAmount", type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * PonsV2LaunchAndBuy router.
 *
 * Selector 0xf85f8e41 confirmed present in deployed bytecode at
 * 0xe33E9E479dF8802cb0866d5d05258bEc4cF62948, and observed in real mainnet launch
 * calldata. It is publicly callable: it is the contract the factory trusts as
 * `launchForwarder`, so it can call the restricted `launchTokenFor` and pass the
 * real caller through as `originalDeployer`. The user therefore stays the on-chain
 * creator and keeps fee-sweep authority.
 *
 * Two rules that bite:
 *   - msg.value is checked with `!=`, not `<`. Native launches must send exactly
 *     launchFee + quoteIn; ERC-20 launches must send exactly launchFee. One wei
 *     either way reverts NativeValueMismatch (0xbc760cfe).
 *   - Declarable exemptions are 31, not 32: the router appends `recipient` and the
 *     factory ceiling is 32. No public getter exposes the router's own limit, so
 *     validate by simulation before spending a launch fee.
 */
export const ponsV2LaunchAndBuyAbi = [
  {
    type: "function",
    name: "launchAndBuy",
    stateMutability: "payable",
    inputs: [
      {
        name: "tokenParams",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "logo", type: "string" },
          { name: "description", type: "string" },
          {
            name: "socials",
            type: "tuple",
            components: [
              { name: "website", type: "string" },
              { name: "twitter", type: "string" },
              { name: "telegram", type: "string" },
              { name: "discord", type: "string" },
              { name: "farcaster", type: "string" },
            ],
          },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "expectedEconomics", type: "bytes32" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
      { name: "quoteIn", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "snipeTaxExemptions", type: "address[]" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "curve", type: "address" },
    ],
  },
  {
    type: "function",
    name: "factory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;
