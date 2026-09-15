/**
 * PonsV2LaunchFactory ABI fragments.
 *
 * PROVENANCE — read this before adding anything.
 *
 * These fragments are not copied wholesale from the Pons GitHub repository,
 * because that repository was found to be out of sync with its own deployment:
 * `PonsV2LaunchFactory.sol` calls `exemptFromSnipeTax` on the curve while
 * `PonsV2BondingCurve.sol` in the same commit does not define it, so that source
 * set cannot compile. `snipeTaxSeconds` also reads 3 on-chain versus 15 in source.
 *
 * Every fragment below was confirmed present in the DEPLOYED bytecode at
 * 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e by 4-byte selector scan, and the
 * read functions were additionally exercised against mainnet.
 *
 * Rule: do not add a fragment here until its selector is confirmed in deployed
 * bytecode. `pnpm verify:pons` re-checks the load-bearing ones.
 */

export const ponsV2FactoryAbi = [
  // ── Launch configuration ───────────────────────────────────────────────────
  {
    type: "function",
    name: "launchConfigCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getLaunchConfig",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "supply", type: "uint256" },
          { name: "curveFeeBps", type: "uint256" },
          { name: "phantomQuote", type: "uint256" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "enabled", type: "bool" },
        ],
      },
    ],
  },

  // ── Launch records ─────────────────────────────────────────────────────────
  {
    type: "function",
    name: "getLaunchedToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "curve", type: "address" },
          { name: "deployer", type: "address" },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "pairToken", type: "address" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "phase", type: "uint8" },
          { name: "sweptQuote", type: "uint256" },
          { name: "sweptTokens", type: "uint256" },
          { name: "sweptAt", type: "uint256" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getLaunchFeePolicy",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
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

  // ── Owner-mutable parameters: read live, never cache long ──────────────────
  {
    type: "function",
    name: "launchFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "launchEnabled",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "maxCreatorTaxBps",
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
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },

  // ── Wired component addresses. Note the naming: `locker()` not
  //    `launchLocker()`, `memeHook()` not `hook()`, and there is deliberately no
  //    `feePolicy()` — the meme hook IS the fee policy.
  {
    type: "function",
    name: "memeHook",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "graduationExecutor",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "launchDeployer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "locker",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "buybackVault",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "graduationGuard",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "launchForwarder",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "poolManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "positionManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },

  // ── Approved quote assets ──────────────────────────────────────────────────
  {
    type: "function",
    name: "approvedPairTokens",
    stateMutability: "view",
    inputs: [{ name: "pairToken", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "pairTokenEconomics",
    stateMutability: "view",
    inputs: [{ name: "pairToken", type: "address" }],
    outputs: [
      { name: "phantomQuote", type: "uint256" },
      { name: "graduationThreshold", type: "uint256" },
    ],
  },

  // ── Economics pin. Always call this and pass the result into a launch, or an
  //    owner re-peg can land underneath an in-flight transaction.
  {
    type: "function",
    name: "previewLaunchEconomics",
    stateMutability: "view",
    inputs: [
      { name: "launchConfigId", type: "uint256" },
      { name: "pairToken", type: "address" },
    ],
    outputs: [{ type: "bytes32" }],
  },

  // ── Permissionless graduation progression ──────────────────────────────────
  {
    type: "function",
    name: "graduate",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "createGraduatedPool",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "positionId", type: "uint256" }],
  },

  // ── Events. Verified: TokenLaunched decoded a real mainnet log, topic0
  //    0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "curve", type: "address", indexed: true },
      { name: "deployer", type: "address", indexed: true },
      { name: "pairToken", type: "address", indexed: false },
      { name: "launchConfigId", type: "uint256", indexed: false },
      { name: "graduationThreshold", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LaunchSwept",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "quoteOut", type: "uint256", indexed: false },
      { name: "tokenOut", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LaunchForceSwept",
    inputs: [{ name: "token", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "PoolGraduated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "positionId", type: "uint256", indexed: false },
      { name: "tokenAmount", type: "uint256", indexed: false },
      { name: "pairTokenAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "GraduationTokensPermanentlyLocked",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LaunchConfigAdded",
    inputs: [{ name: "id", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "LaunchConfigUpdated",
    inputs: [{ name: "id", type: "uint256", indexed: true }],
  },
] as const;
