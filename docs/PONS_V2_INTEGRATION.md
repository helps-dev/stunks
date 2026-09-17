# Pons V2 Integration Specification

**Verified:** 2026-09-15, Robinhood Chain mainnet (`4663`), head block `63,444,974`
**Verification RPC:** `https://robinhood.drpc.org`
**Published source:** `github.com/ponsdotdev/ponsfamily` @ `contractsV2/src/v2/`

> **Read this first.** The published GitHub source is **not** a reliable
> description of the deployed contracts. This audit found the repository's
> `PonsV2BondingCurve.sol` is missing a whole subsystem that the deployed
> bytecode has, and that the factory source calls. Treat the repo as
> documentation and the chain as truth. Details in §8 and `KNOWN_RISKS.md` R1.

---

## 1. Addresses

### Published (from the repo README)

| Generation | Contract              | Address                                      | Deployed code |
| ---------- | --------------------- | -------------------------------------------- | ------------- |
| V1         | `PonsLaunchFactory`   | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | 24,353 B      |
| V2         | `PonsV2LaunchFactory` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | 24,177 B      |

STUNKS V1 integrates **V2 only**. V1 is a different protocol (day-one Uniswap V3
pool, no curve) and is out of scope.

V2 factory deployment block, found by binary search over `eth_getCode`:

```text
block 26,841,846   2026-08-03T14:41:19Z    ← INDEXER_START_BLOCK
```

### Discovered on-chain (read FROM the factory — never hardcode from docs)

Every address below was read from the deployed factory or hook at audit time.
All have code. None of these appear in the repo README.

| Role                           | Getter                        | Address                                      | Code     |
| ------------------------------ | ----------------------------- | -------------------------------------------- | -------- |
| Meme hook / fee policy         | `memeHook()`                  | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | 15,167 B |
| Graduation executor            | `graduationExecutor()`        | `0xC7819B64A1dAECD7eC19856d026cb14EfBd89046` | 4,402 B  |
| Launch deployer                | `launchDeployer()`            | `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` | 20,906 B |
| Launch locker                  | `locker()`                    | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` | 1,969 B  |
| Buyback vault                  | `buybackVault()`              | `0x42df2a798f82289E177311362e8f5ccC45c1219c` | 4,602 B  |
| Graduation guard               | `graduationGuard()`           | `0xf5695117b99B6f6401e67d4195BD653628176C6C` | 2,896 B  |
| Launch forwarder               | `launchForwarder()`           | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` | 4,416 B  |
| Uniswap V4 PoolManager         | `poolManager()`               | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | 24,009 B |
| Uniswap V4 PositionManager     | `positionManager()`           | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | 23,877 B |
| Fee escrow                     | `memeHook.feeEscrow()`        | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` | —        |
| Protocol owner / fee recipient | `owner()`                     | `0x263ed295dAFaE1d9AAdD6E56c4B6F9f38eE019Dd` | EOA      |
| Fee sweep operator             | `memeHook.feeSweepOperator()` | `0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2` | EOA      |

**Naming traps found during verification:**

- The factory has **no** `feePolicy()` getter and **no** `launchLocker()` getter.
  The locker getter is `locker()`. The fee policy is not a separate contract —
  **`PonsV2MemeHook` itself implements `IPonsV2FeePolicy`**.
- `hook()` does not exist; it is `memeHook()`.

`packages/pons/addresses` resolves all of these by calling the factory at boot
and caching per chain ID, with the factory address as the only configured input.
This is deliberate: the protocol owner can rotate the executor, deployer, and
forwarder (`setGraduationExecutor`, `setLaunchDeployer`, `setLaunchForwarder`),
so a hardcoded list goes stale silently.

---

## 2. Launch configuration — live values

`launchConfigCount()` = **1**. Do not hardcode; read it and iterate.

`getLaunchConfig(0)`:

| Field                 | Raw value                      | Meaning                      |
| --------------------- | ------------------------------ | ---------------------------- |
| `supply`              | `1000000000000000000000000000` | 1,000,000,000 tokens @ 18 dp |
| `curveFeeBps`         | `100`                          | 1.00% base trade fee         |
| `phantomQuote`        | `1680000000000000000`          | 1.68 ETH virtual reserve     |
| `graduationThreshold` | `4200000000000000000`          | 4.2 ETH real quote reserve   |
| `poolFee`             | `0`                            | V4 LP fee tier (see §7)      |
| `tickSpacing`         | `200`                          | V4 tick spacing              |
| `enabled`             | `true`                         | selectable                   |

Derived: `reservedTokens` = 285,714,285,714,285,714,285,714,285 → **28.571%** of
supply is held back to seed the V4 pool, **71.429%** is sellable on the curve.

### Factory-level launch parameters (all owner-mutable → read live)

| Getter               | Live value                     | Repo source says | Note                            |
| -------------------- | ------------------------------ | ---------------- | ------------------------------- |
| `launchFee()`        | `500000000000000` (0.0005 ETH) | —                | paid on `launchToken`           |
| `launchEnabled()`    | `true`                         | —                | global kill switch              |
| `maxCreatorTaxBps()` | `1000` (10%)                   | —                | ceiling on creator tax          |
| `snipeTaxStartBps()` | `9900` (**99%**)               | `9900`           | anti-snipe start                |
| `snipeTaxSeconds()`  | **`3`**                        | **`15`**         | **source is stale — read live** |

`snipeTaxSeconds` differing between source and chain is direct proof that these
values must be read at runtime, and that the repo cannot be trusted for constants.

---

## 3. Launch flow

Three entrypoints exist on the deployed factory:

```solidity
function launchToken(TokenParams params, uint256 launchConfigId, address pairToken)
    payable returns (address token, address curve);

function launchToken(TokenParams params, uint256 launchConfigId, address pairToken,
                     address[] snipeTaxExemptions)
    payable returns (address token, address curve);

// launchForwarder only — for the atomic launch-and-buy router
function launchTokenFor(TokenParams params, uint256 launchConfigId, address pairToken,
                        address originalDeployer, address[] snipeTaxExemptions)
    payable returns (address token, address curve);
```

`TokenParams` (from source, field order matters for encoding):

```solidity
struct TokenParams {
    string name;
    string symbol;
    string logo;
    string description;
    PonsV2LauncherToken.Socials socials;
    address creatorFeeRecipient;
    uint16  creatorTaxBps;        // ≤ maxCreatorTaxBps() at launch time
    bool    buybackEnabled;
    bytes32 expectedEconomics;    // 0 waives the check — see below
    bytes32 salt;                 // CREATE2 salt, per initiating account
}
```

### `expectedEconomics` is a front-running guard and STUNKS must use it

Zero waives the check. Waiving it means the protocol owner can re-peg supply,
fee, threshold, or pool fee underneath a launch that is already in the user's
wallet waiting to be signed.

Correct usage: call `previewLaunchEconomics(launchConfigId, pairToken)` at quote
time and pass the returned `bytes32` into the launch. The preimage is
`keccak256(abi.encode(...))` over ten values in this exact order:

```text
uint256 phantomQuote
uint256 graduationThreshold
uint256 config.supply
uint256 config.curveFeeBps
uint24  config.poolFee
int24   config.tickSpacing
uint16  policy.protocolFeeShareBps
uint16  policy.buybackBurnBps
uint16  policy.hookFeeBps
uint16  policy.maxInternalPriceImpactBps
```

STUNKS calls the contract for this value rather than encoding it locally, so a
future field addition cannot silently produce a wrong pin.

`salt` must be checked with `PonsV2LaunchDeployer.predictLaunchAddresses` before
sending; reuse on identical terms reverts because the pair already exists.

---

## 4. Bonding curve — verified deployed surface

Verified by scanning the runtime bytecode of live curve
`0xe0d8C6a8c6F4aEA8e86A613FFB5545cC9372d87A` (token `TIKI`,
`0x0f24bfe09A097Bd6c424A285718b21d10E9f5F22`), 10,229 B.

### Trading

```solidity
function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
    payable returns (uint256 tokensOut);          // 0x59a87bc1

function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
    returns (uint256 quoteOut);                   // 0xd04c6983
```

- Native-quote launches (`pairToken == address(0)`): `quoteIn` **must equal**
  `msg.value`.
- ERC-20-quote launches: send **no** value, and the credited amount is the
  observed balance delta, not the requested amount. `sell` requires an ERC-20
  approval of the launch token to the curve first.
- `buy` **partially fills** rather than reverting when a trade would cross
  `reservedTokens`; the surplus is refunded and `CurveBuyRefunded` is emitted.
  In that case `minTokensOut` is reinterpreted as a **price** bound, not a
  quantity bound. A UI that treats `minTokensOut` as a guaranteed quantity will
  misreport the final trade of every launch.

### State reads (all present)

```text
getReserves() → (quoteReserve, tokenReserve)   0x0902f1ac
realQuoteReserve()                             0x4f1f58fd
quoteReserve()  tokenReserve()
readyToGraduate()                              0xc68360a5
sellableTokens()  reservedTokens()  phantomQuote()
feeBps()  creatorTaxBps()  graduationThreshold()  graduated()
trackedQuote()  trackedTokens()  token()  pairToken()
sweepFees(uint256)
```

Live example values on the TIKI curve: `feeBps = 100` (1%),
`creatorTaxBps = 200` (2%) → 3% total per trade.

### Reserve semantics

```text
getReserves().quoteReserve = phantomQuote + trackedQuote
                             - quoteFeeBalance - creatorTaxBalance
realQuoteReserve()         = trackedQuote - quoteFeeBalance - creatorTaxBalance
```

`getReserves()` is the **pricing** reserve (includes the virtual/phantom
liquidity). `realQuoteReserve()` is the **graduation-progress** reserve (real
assets only). Using the wrong one is a silent, plausible-looking pricing bug:
at launch, `getReserves()` reports 1.68 ETH while `realQuoteReserve()` is 0.

Both are tracked internally rather than read from live balances, so a forced
transfer in (ERC-20 airdrop, `selfdestruct` ETH) cannot move price or push a
launch past its threshold.

---

## 5. Quoting — no on-chain quoter exists

Confirmed absent from deployed bytecode:

```text
quoteBuy(uint256)           0x4beb394c   ABSENT
quoteSell(uint256)          0xa64190c4   ABSENT
getAmountOut(uint256,bool)  0x11106ee2   ABSENT
```

The PRD assumed these exist. They do not.

### Exact math (from `PonsV2BondingCurveMath`, verified against chain)

The curve calls the library with `feeBps = 0` and applies fees itself, so the
library reduces to plain constant product:

```text
buy:
  fee = quoteIn * feeBps        / 10000        // floor
  tax = quoteIn * creatorTaxBps / 10000        // floor
  net = quoteIn - fee - tax
  tokensOut = (net * tokenReserve) / (quoteReserve + net)      // floor

sell:
  grossQuoteOut = (tokensIn * quoteReserve) / (tokenReserve + tokensIn)  // floor
  fee = grossQuoteOut * feeBps        / 10000
  tax = grossQuoteOut * creatorTaxBps / 10000
  quoteOut = grossQuoteOut - fee - tax
```

Note the asymmetry: on a **buy** the fee is taken from the input before pricing;
on a **sell** it is taken from the output after pricing. Both are quote-denominated.

Verified exact to the wei against `eth_call` on a live curve:

| Input    | Off-chain prediction          | On-chain simulation           | Match |
| -------- | ----------------------------- | ----------------------------- | ----- |
| 0.01 ETH | `5740664023199384506125347`   | `5740664023199384506125347`   | yes   |
| 0.1 ETH  | `54586381541924592009003939`  | `54586381541924592009003939`  | yes   |
| 1 ETH    | `366037735849056603773584905` | `366037735849056603773584905` | yes   |

All divisions are floor. Reproducing this requires `bigint` throughout — one
float conversion breaks the match.

### Required policy

1. Fast path: off-chain math for interactive quoting.
2. Authoritative path: `eth_call` simulation of `buy`/`sell` before signing.
3. **Simulation only, no off-chain math**, when the curve is inside its snipe-tax
   window, because the decay formula is unverified (§8).
4. If simulation reverts, surface the revert. Never fall back to a dummy number.

---

## 6. Graduation

### Phases

```solidity
enum GraduationPhase { NotGraduated, Swept, PoolCreated, Rescued }
```

`getLaunchedToken(address token)` returns the authoritative record:

```solidity
struct LaunchedToken {
    address token; address curve; address deployer;
    address creatorFeeRecipient; address pairToken;
    uint256 graduationThreshold;
    uint24  poolFee; int24 tickSpacing;      // snapshotted at launch
    uint16  creatorTaxBps; bool buybackEnabled;
    GraduationPhase phase;
    uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt;
    bool exists;
}
```

`exists` is the check that a token is genuinely a Pons V2 launch. STUNKS must
gate every trading UI on it.

### Two-phase, permissionless

```text
graduate(address token)             — permissionless; drains curve into factory
createGraduatedPool(address token)  — permissionless; seeds V4 pool, RETRYABLE
```

`_tryAutoGraduate()` runs inside the threshold-crossing buy but **swallows
failure** and emits `AutoGraduationFailed(token, gasRemaining)`. So a token can
sit in `Swept` with no pool. Both progression calls are permissionless, meaning
STUNKS _may_ offer a "complete graduation" action — but only after the exact
gas and revert behaviour is characterised on a real stuck launch. No graduation
bot in Phase 1–5.

Owner-only recovery paths exist and must be reflected in the UI, not hidden:
`forceSweptGraduation`, `rescueCurveFees`, `rescueSweptGraduation`.

### Progress

`reservedTokens = supply * phantomQuote / (phantomQuote + graduationThreshold)`
— verified byte-exact on-chain. The quote threshold and the token allocation are
the same point, so display `realQuoteReserve / graduationThreshold` and gate on
`readyToGraduate()` (`sellableTokens() == 0`).

---

## 6b. `PonsV2LaunchAndBuy` — atomic launch + creator buy

```text
0xe33E9E479dF8802cb0866d5d05258bEc4cF62948   4,416 B
launchAndBuy(...)   selector 0xf85f8e41   VERIFIED PRESENT, publicly callable
```

This is the same address the factory stores as `launchForwarder`, and that is why
it works: it is the one contract permitted to call the factory's restricted
`launchTokenFor`, which passes the real caller through as `originalDeployer`. The
user therefore remains the on-chain creator.

```solidity
launchAndBuy(
    TokenParams tokenParams,
    uint256 launchConfigId,
    address pairToken,
    uint256 quoteIn,
    uint256 minTokensOut,
    address recipient,
    address[] snipeTaxExemptions
) payable
```

One transaction: deploy token → deploy curve (CREATE2) → register exemptions →
execute the creator's buy. No block gap, so the creator's own buy cannot be
front-run.

Rules, verified:

- `msg.value` is checked with `!=`, not `<`:
  `nativeQuote ? launchFee + quoteIn : launchFee`. One wei over or under reverts
  `NativeValueMismatch` (`0xbc760cfe`).
- Declarable exemptions: **31**, verified by simulation rather than assumed. The
  router appends `recipient` against a factory ceiling of 32. Measured boundary:
  31 declared succeeds, 32 reverts. Re-check with `pnpm probe:exemptions`; the
  constant lives in `@stunks/config` as `MAX_DECLARABLE_SNIPE_EXEMPTIONS`.
- Because the curve is CREATE2-derived from a caller-chosen salt, simulating this
  call yields the curve address **before anything is broadcast**. That is what makes
  a prepared bundle possible (`WHITELIST_LAUNCH.md`).

**Footgun:** a `buy` sent to the curve address before the launch executes does
**not** revert. The value is transferred and stranded at an address with no code.
Never broadcast a buy before the launch receipt.

---

## 6c. Approved pair assets — read them, do not derive them

`pairTokenEconomics(address) → (phantomQuote, graduationThreshold)` and
`approvedPairTokens(address) → bool` are both present on the factory. Native ETH
uses launch config 0; every ERC-20 pair carries its own economics.

Spot-verified against the chain:

| Pair | Address                                      | Dec   | `phantomQuote`         | `graduationThreshold`  |
| ---- | -------------------------------------------- | ----- | ---------------------- | ---------------------- |
| USDG | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` | **6** | `3236000000`           | `8090000000`           |
| NVDA | `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec` | 18    | `16640000000000000000` | `41600000000000000000` |
| TSLA | `0x322f0929c4625ed5bad873c95208d54e1c003b2d` | 18    | `10400000000000000000` | `26000000000000000000` |
| AAPL | `0xaf3d76f1834a1d425780943c99ea8a608f8a93f9` | 18    | `9680000000000000000`  | `24200000000000000000` |
| MSFT | `0xe93237c50d904957cf27e7b1133b510c669c2e74` | 18    | `6431455767077268559`  | `16078639417693171399` |

Third-party documentation lists 11 approved ERC-20 pairs in total (adding SPCX,
SNAP, SPY, QQQ, BB, F). The five above were re-read directly and matched exactly,
including MSFT's non-round full-precision values.

Two hard rules:

- **USDG has 6 decimals.** Never assume 18 for a pair asset.
- **Never derive `graduationThreshold` as `phantomQuote × 2.5`.** The ratio is
  close, but MSFT, SNAP, QQQ, BB and F carry non-round values and a derivation
  drifts in the low decimals. Read the actual value.

Every pair is tuned to the same ~71.42–71.43% sellable share, so pool depth is
comparable regardless of quote asset. The small spread is integer `mulDiv`
rounding, not policy.

ERC-20 pairs also differ mechanically: the creator **approves** the router and
sends only `launchFee` as value; sending extra value reverts
`UnexpectedNativeValue`. Credit is computed from the observed balance delta, so
fee-on-transfer assets are handled correctly.

Observed usage across 299 decoded `launchAndBuy` transactions (third-party
figure, not re-derived here): 86.6% native ETH, 13.4% ERC-20, led by USDG at 5.4%.

---

## 7. Post-graduation: Uniswap V4

Graduated tokens trade on the V4 PoolManager singleton
`0x8366a39CC670B4001A1121B8F6A443A643e40951`, with `PonsV2MemeHook` attached.

Pool key components come from the launch record (`poolFee`, `tickSpacing`,
`pairToken`) and the hook address — never invented. `poolFee = 0` in config 0,
consistent with the hook taking the fee via `hookFeeBps` instead of the LP tier.

`UNKNOWN` — V4 quoting path:

```text
Question:
  How does STUNKS quote and route swaps on graduated pools? Is a canonical
  Uniswap V4 Quoter / UniversalRouter deployed on Robinhood Chain, and at what
  address?

Why it matters:
  Phase 5 cannot deliver graduated-token trading without it. The hook's
  beforeSwap/afterSwap logic also affects the effective price, so a naive
  constant-product estimate would be wrong.

How to verify:
  Locate a graduated Pons V2 token (factory PoolGraduated logs), read its
  PoolRegistered entry on the hook, then probe candidate V4 periphery addresses
  for code and simulate a swap. Compare against a real historical swap.

Current assumption:
  NONE. No graduated-token trading will be implemented until this is verified.
```

---

## 8. The snipe tax — deployed but undocumented

The factory source calls `PonsV2BondingCurve(curve).exemptFromSnipeTax(...)`, but
the repo's `PonsV2BondingCurve.sol` contains **zero** occurrences of `snipeTax`.
The published V2 source set is internally inconsistent and would not compile.

Bytecode scanning of the deployed curve proves the deployed version has the
subsystem:

| Selector     | Function                      | In repo source? |
| ------------ | ----------------------------- | --------------- |
| `0x31ff7f22` | `exemptFromSnipeTax(address)` | **no**          |
| `0x50e25ac2` | `snipeTaxStartBps()`          | **no**          |
| `0x6783774b` | `snipeTaxSeconds()`           | **no**          |
| `0xbf56b371` | `launchedAt()`                | **no**          |
| `0xd44bdfe7` | `snipeTaxExempt(address)`     | **no**          |

Live values on the TIKI curve: `snipeTaxStartBps = 9900` (**99%**),
`snipeTaxSeconds = 3`, `launchedAt = 1789453633`. These are per-curve, so read
them from the curve, not the factory.

### Empirically measured behaviour (archive simulation, not assumption)

Because the source is unavailable, the snipe tax was characterised by simulating
`buy(0.05 ETH)` against curve `0xe0d8…d87A` at historical blocks, using archive
`eth_call` with a balance state override. Launch block `63,444,887`,
`launchedAt = 1789453633`, `snipeTaxSeconds = 3`.

| #   | Sender          | Recipient           | Block (age)      | Tokens out                   |
| --- | --------------- | ------------------- | ---------------- | ---------------------------- |
| A   | exempt deployer | exempt deployer     | 63,444,888 (0 s) | `28059010702921608330922765` |
| B   | non-exempt      | non-exempt          | 63,444,888 (0 s) | `297530496875929782802737`   |
| C   | **non-exempt**  | **exempt deployer** | 63,444,888 (0 s) | `28059010702921608330922765` |
| D   | exempt deployer | **non-exempt**      | 63,444,888 (0 s) | `297530496875929782802737`   |
| E   | non-exempt      | non-exempt          | 63,444,913 (3 s) | `28059010702921608330922765` |

Three facts follow, and all three are load-bearing for the STUNKS whitelist
feature:

1. **The exemption keys on `recipient`, not on `msg.sender`.** C is identical to
   A, and D is identical to B. Who pays is irrelevant; who receives the tokens
   is what the tax looks at.
2. The effective tax on a non-exempt recipient at age 0 is **~98.94%** — a
   **94.31x** difference in tokens received for the same ETH.
3. The window closes exactly on `snipeTaxSeconds`: at age 3 s a non-exempt
   recipient receives the full untaxed amount (E equals A).

**Consequence:** one funded wallet can buy for all 32 whitelisted recipients and
every one of those buys is untaxed. Multi-wallet key management is not required.
See `WHITELIST_LAUNCH.md`.

### Measured decay curve

Swept on curve `0x9bbA…1870`, a launch that declared a **real** whitelist. Sender
held constant (one non-whitelisted wallet); only `recipient` varied. Same block
means same reserves, so the ratio isolates the tax.

| Age (s) | Whitelisted recipient        | Non-whitelisted recipient    | Implied tax |
| ------- | ---------------------------- | ---------------------------- | ----------- |
| 0       | full                         | ~1% of full                  | **~98.94%** |
| 1       | `28059010702921608330922765` | `26318382297540874342909801` | **6.20%**   |
| 2       | `15902399517500391236905098` | `15871909518796072853382156` | **0.19%**   |
| 3       | identical                    | identical                    | **0.00%**   |
| 4       | identical                    | identical                    | 0.00%       |

The decay is **steep and non-linear**, not a straight line from 99% to 0. The
practical protection lives almost entirely in the **first second**. By age 2 the
tax is negligible for everyone.

Product consequence: the whitelist advantage is the ability to buy in the launch
block at zero tax while everyone else must wait ~2 seconds for the tax to fall.
Realising it requires landing the buy at age 0–1, which is why an atomic bundler
is materially better than sequential buys. See `WHITELIST_LAUNCH.md` §3.

Also verified on that launch: `snipeTaxExempt(whitelistedAddress) == true`, so the
explicit `snipeTaxExemptions[]` array does register arbitrary third-party
addresses, not just the deployer.

Sampling note: of 185 recent launches, 124 used the exemption overload with an
**empty** list, 60 used another entrypoint, and only **1** declared a non-empty
whitelist. Almost nobody is using this protection today.

### Decay formula — RESOLVED

Third-party documentation (`PONS-V2-BUNDLER.md`) states the formula as a bit shift:

```text
snipeTaxBps = snipeTaxStartBps >> floor(elapsed * 14 / snipeTaxSeconds)
```

Evaluated with the live values `snipeTaxStartBps = 9900`, `snipeTaxSeconds = 3`:

| Age | shift | Formula bps   | Independently measured |
| --- | ----- | ------------- | ---------------------- |
| 0 s | 0     | 9900 (99.00%) | ~98.94%                |
| 1 s | 4     | 618 (6.18%)   | 6.20%                  |
| 2 s | 9     | 19 (0.19%)    | 0.19%                  |
| 3 s | 14    | 0 (0.00%)     | 0.00%                  |

The formula reproduces measurements taken **before** that document was available,
which is strong mutual corroboration. 14 shifts is chosen because 2^14 = 16384
exceeds 9900, so the tax genuinely reaches zero inside the window instead of being
cut off while still material.

Better still, the deployed curve exposes the value directly:

```text
currentSnipeTaxBps(address recipient) → uint256      0xd7e1ef39   VERIFIED PRESENT
```

**STUNKS reads `currentSnipeTaxBps(recipient)` rather than computing the shift.**
The formula is documented here for understanding, not for reimplementation.

Note the argument: the tax is evaluated **per recipient**, which is the same fact
established by simulation above.

Still unknown:

```text
UNKNOWN

Question:
  Where does the collected snipe tax go — protocol fee, creator, buyback, or the
  curve reserve? The bit-shift formula and the per-recipient lookup are settled,
  but the destination of the taxed amount is not.

Why it matters:
  Only for fee analytics and for describing the mechanism honestly to users. It
  does not affect quoting, because quotes come from currentSnipeTaxBps and
  simulation.

Why it matters:
  It is up to 99% of the trade. A quote that ignores it during the first ~3
  seconds of a launch would show a user a number off by up to 100x. Launch-and-buy
  and any "snipe the new launch" UX lands exactly inside this window.

How to verify:
  Retrieve the verified source or decompile the deployed curve; then confirm by
  simulating buys at successive timestamps on a freshly launched curve and
  fitting the observed output.

Current assumption:
  NONE. STUNKS quotes fresh launches by eth_call simulation only, and the UI
  labels the window explicitly as an anti-snipe period.
```

---

## 9. Events — verified signatures

`TokenLaunched` was decoded from a **real on-chain log** using the repo ABI,
confirming the signature matches the deployment:

```text
topic0 0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607

event TokenLaunched(
    address indexed token, address indexed curve, address indexed deployer,
    address pairToken, uint256 launchConfigId, uint256 graduationThreshold)

decoded sample (block 63,444,887):
  token   0x0f24bfe09A097Bd6c424A285718b21d10E9f5F22
  curve   0xe0d8C6a8c6F4aEA8e86A613FFB5545cC9372d87A
  deployer 0x7d3a7e460425f0b407174608670889377c41E9BC
  pairToken 0x0000…0000 (native ETH)
  launchConfigId 0
  graduationThreshold 4200000000000000000
```

### The PRD's event names are wrong

There is no `Buy` and no `Sell` event. On the **curve**:

```solidity
event CurveBuy(address indexed buyer, address indexed recipient,
               uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax);
event CurveSell(address indexed seller, address indexed recipient,
                uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax);
event CurveBuyRefunded(address indexed buyer, uint256 refund);
event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount);
event BuybackLocked(uint256 quoteSpent, uint256 tokensLocked);
event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut);
event AutoGraduationFailed(address indexed token, uint256 gasRemaining);
event Initialized(address token);
```

On the **factory**:

```solidity
event TokenLaunched(...);                       // above
event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut);
event LaunchForceSwept(address indexed token);
event PoolGraduated(address indexed token, uint256 positionId,
                    uint256 tokenAmount, uint256 pairTokenAmount);
event GraduationTokensPermanentlyLocked(address indexed token, uint256 amount);
event LaunchGraduationRescued(...);
event LaunchConfigAdded(uint256 indexed id);
event LaunchConfigUpdated(uint256 indexed id);
// plus owner-config events: LaunchFeeUpdated, LaunchEnabledUpdated,
// MaxCreatorTaxUpdated, SnipeTaxStartBpsUpdated, SnipeTaxSecondsUpdated,
// GraduationExecutorSet, LaunchDeployerSet, LaunchForwarderSet,
// PairTokenApprovalUpdated, PairTokenEconomicsUpdated,
// CreatorFeeRecipientUpdated / …ChangeProposed / …ChangeCancelled,
// BuybackEnabledUpdated, WhitelistedLauncherUpdated
```

On the **meme hook** (post-graduation):

```solidity
event PoolRegistered(PoolId indexed poolId, address memecoin,
                     address quoteToken, address creator);
event HookFeeCollected(PoolId indexed poolId, address currency,
                       uint256 feeAmount, uint256 taxAmount);
event PoolFeesSwept(...);
event PoolBuybackSkipped(PoolId indexed poolId, uint256 foldedBackQuote);
event PoolConversionSkipped(PoolId indexed poolId, uint256 retainedMemecoin);
```

`PoolRegistered` is the join between a token and its V4 `poolId` — required to
index graduated volume from PoolManager `Swap` events.

```text
UNKNOWN

Question:
  Exact event signatures on the fee escrow 0xd3AFEB2a…Ac9e (the PRD lists
  Credited / Claimed / CreditedToken / ClaimedToken).

Why it matters:
  Needed for creator-earnings analytics. Not needed for trading.

How to verify:
  Fetch the verified ABI from the explorer, or scan escrow logs and match topics.

Current assumption:
  NONE. Creator earnings display is deferred until verified.
```

---

## 10. Fee model — live values

Read from `PonsV2MemeHook` (which _is_ `IPonsV2FeePolicy`):

| Parameter                   | Value        |
| --------------------------- | ------------ |
| `protocolFeeShareBps`       | `3000` (30%) |
| `buybackBurnBps`            | `5000` (50%) |
| `hookFeeBps`                | `100` (1%)   |
| `maxInternalPriceImpactBps` | `300` (3%)   |

Split arithmetic, from the curve's `_sweepFees`:

```text
protocolAmount = pendingFee * protocolFeeShareBps / 10000     // 30% of base fee
creatorBucket  = pendingFee - protocolAmount                   // 70%
buybackAmount  = buybackEnabled ? min(buybackEarmark, creatorBucket) : 0
creatorAmount  = creatorBucket - buybackAmount + creatorTaxBalance
```

So with buyback enabled: **protocol 30% / buyback 50% / creator 20%** of the base
fee, and the creator additionally receives **100% of the creator tax**.

The buyback folds back into the creator payout when the curve is too thin to
execute it within `maxInternalPriceImpactBps`, or when it would eat into
`reservedTokens`. Buybacks **vest over five years** in `PonsV2BuybackVault`; they
are not burned. UI copy must not say "burn".

Fee terms are **snapshotted per launch** at creation (`FeePolicySnapshot`), so a
later policy change does not alter existing launches. STUNKS must display each
token's snapshot via `getLaunchFeePolicy(token)`, not the current global policy.

### STUNKS revenue

No parameter routes value to STUNKS. Platform revenue in V1 is **zero** and must
be displayed as such. `FeeAdapter` stays a read-only analytics interface with no
deployed contract behind it.

---

## 11. Package boundary

```text
packages/pons/
├── abi/            hand-verified fragments; snipe-tax fns added from bytecode
├── addresses/      factory address in; everything else resolved on-chain
├── client/         typed reads, batched via multicall where safe
├── launch/         previewLaunchEconomics → launchToken, salt prediction
├── curve/          reserves, exact quote math, buy/sell encoding
├── graduation/     phase resolution, progress, venue resolver
├── fees/           snapshot reads, split math, escrow (read-only)
├── events/         decoders keyed by verified topic0
├── types/          GraduationPhase, LaunchedToken, LaunchConfig
└── index.ts
```

Functions mirror the real ABI only. There is deliberately no `quoteBuy` wrapper
that pretends to be a contract call — the quote module is named for what it is:
local math plus simulation.

---

## 12. Reproducing this verification

The probe scripts used for this audit live outside the repo (`/tmp/pons-verify`).
Phase 1 moves them to `scripts/verify-pons.ts` so the numbers in this document
can be re-checked in CI and drift is caught automatically.

Checks to keep: chain ID, factory code presence, resolved address set, launch
config dump, live fee policy, curve selector presence (including the snipe-tax
set), and off-chain-math-vs-simulation equality.
