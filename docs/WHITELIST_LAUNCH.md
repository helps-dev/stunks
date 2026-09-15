# STUNKS Protected Launch — whitelist bundle buy

**Status:** design verified against mainnet, not yet implemented (Phase 2)
**Depends on:** `PONS_V2_INTEGRATION.md` §8

This is the STUNKS flagship differentiator: launch a Pons V2 token and have up to
32 pre-declared wallets receive tokens at the untaxed price, from inside STUNKS,
with no external sniper bot and no private keys handed to STUNKS.

---

## 1. Why it works

Pons applies a decaying anti-snipe tax to the opening seconds of every launch.
Measured on mainnet: **~98.94% at age 0**, window **3 seconds**, start
`9900 bps`. The launch transaction may declare an exemption list.

Two verified contract facts make the feature possible:

1. `MAX_SNIPE_TAX_EXEMPTIONS = 32` — the factory accepts up to 32 addresses,
   declared in the launch call. The deployer and the creator fee recipient are
   exempted automatically, on top of the 32.
2. **The exemption is checked against `recipient`, not `msg.sender`** (proven by
   simulation, `PONS_V2_INTEGRATION.md` §8).

Fact 2 is the whole feature. It means a single wallet can pay for buys delivered
to 32 different exempt addresses, and none of them pay the tax. There is no need
to hold 32 private keys, run 32 signers, or operate a bot.

A sniper who is not on the list can still buy, but receives ~1% of the tokens for
the same ETH, which prices them out of competing for the opening allocation.

---

## 2. Flow

```text
─── BEFORE the launch is sent: do every calculation here ───────────────
  1  Creator fills token details, picks pair asset, sets salt
  2  Creator adds up to 31 recipient addresses (the whitelist)
  3  previewLaunchEconomics() → pin expectedEconomics
  4  Simulate launchAndBuy → learn the curve address via CREATE2
     (this is what makes everything below possible)
  5  Read each buyer wallet's balance, nonce, fee cap
  6  Compute permutation-safe slippage floors (§10)
  7  Pre-sign every bundle buy transaction
────────────────────────────────────────────────────────────────────────
                              ↓
  8  ONE signature: launchAndBuy(...) — deploys token + curve,
     registers whitelist, and executes the creator's buy atomically
                              ↓
  9  Wait for the launch receipt (physical floor, ~1 block)
                              ↓
 10  Broadcast the pre-signed bundle: eth_sendRawTransaction only
                              ↓
 11  Whitelisted recipients fill at 0% tax while everyone else faces 99%
```

The reason step 4 unlocks the design: the curve is deployed with CREATE2 from a
salt STUNKS chooses, so its address is knowable before anything is sent. Nothing
in steps 5–7 actually requires the launch to have happened.

Delaying the launch by one preparation round trip costs nothing, because **the
launch is not racing anyone — the launch is the thing being raced.**

Steps 5 and 7 are separate transactions, and step 7 must be **fast**. The
exemption is valid for the whole window, but the *advantage* is not evenly spread
across it: the tax a sniper would pay collapses from ~99% to 0.19% within two
seconds. So the bundle needs to land at age 0–1, not merely inside the window.
See "Timing is the whole game" below.

---

## 3. Two implementation options

### Timing is the whole game

The measured decay (`PONS_V2_INTEGRATION.md` §8) is steep:

```text
age 0 s  →  ~98.94% tax on non-whitelisted
age 1 s  →  6.20%
age 2 s  →  0.19%
age 3 s  →  0%   window closed
```

So the whitelist edge is **not** "3 seconds of protection". It is the ability to
buy in the launch block, at zero tax, while everyone else has to wait roughly two
seconds for the tax to become affordable. Buy at age 2 and the edge is gone,
because by then a sniper pays only 0.19% too.

Every design decision below follows from that: the bundle must land at age 0–1.

### Option A — pre-signed bundle (ship this first, no contract needed)

Every bundle buy is fully signed **before** the launch is sent. After the launch
receipt, the only work left is `eth_sendRawTransaction` for each one.

- No STUNKS smart contract required
- Third-party measurement on this exact chain: bundle landed at **block +5, 0
  seconds elapsed, 4/4 wallets filled, 0 snipers ahead** — while non-whitelisted
  buyers still faced the full 9900 bps. The naive sequential approach landed at
  block +18 with 1/4 wallets.
- Limits: each wallet sends its own transaction, so the fill can be partial, and
  it is **not conditional** — if a sniper somehow lands first, a pre-signed buy
  still executes at the new price up to its slippage floor.
- Requires the buyer wallets' keys to be available to whatever signs them. If the
  creator's 31 wallets are their own, that signing must happen client-side or in
  their own tooling — **STUNKS must not take custody of those keys.** This is the
  open product question in §8.

### Option B — one stateless bundler contract (the only true anti-front-run mode)

A minimal `StunksBundleBuy` contract that, in a single transaction, loops
`curve.buy(amountPerRecipient, minOut, recipients[i])`.

- One signature from one payer, one transaction, **all recipients filled at the
  same price** — recipient 31 gets what recipient 1 gets
- **Can be made conditional**: pin the expected reserves and revert if anyone
  bought first, instead of buying into a moved price. Pre-signed cannot do this.
- Solves the key-custody problem entirely: one payer wallet, N delivery
  addresses, no keys for the other wallets needed at all
- Cost: a new STUNKS contract that routes user ETH. Requires design review and an
  audit before mainnet.

Note that the third-party bundler documented in `PONS-V2-BUNDLER.md` has an
equivalent contract (`PonsBundleExecutor`) verified by simulation but **not
deployed**, for the same reason: it holds several wallets' funds in one call and is
waiting on review. So nobody currently offers the atomic mode on this chain. That
is the actual open opportunity for STUNKS, and also the actual risk.

### The creator's own buy IS atomic — use `launchAndBuy`

**Correction.** An earlier draft of this document claimed launch and buy could not
share a transaction. That was wrong. Pons ships a public router:

```text
PonsV2LaunchAndBuy   0xe33E9E479dF8802cb0866d5d05258bEc4cF62948
launchAndBuy(...)    selector 0xf85f8e41   — verified present, publicly callable
```

It is the same address the factory holds as `launchForwarder`, which is exactly
why it works: the router calls the factory's restricted `launchTokenFor` and
passes the real caller through as `originalDeployer`. So the user stays the
on-chain creator and keeps `sweepFees` / `setCreatorFeeRecipient` authority.

```solidity
launchAndBuy(
    tokenParams,          // same TokenParams struct as launchToken
    launchConfigId,
    pairToken,            // address(0) for native ETH
    quoteIn,              // the creator's own opening buy
    minTokensOut,
    recipient,            // who receives the creator's buy
    snipeTaxExemptions    // the whitelist
)
```

One transaction deploys the token, deploys the curve, registers the whitelist, and
executes the creator's buy. There is **no block gap**, so the creator's own buy
can never be front-run. This entrypoint is in active use on mainnet — it appeared
in the launch sample scanned during this audit.

Two rules that follow, both verified:

- **`msg.value` must be exact**, not a minimum:
  `msg.value == launchFee + quoteIn` for native launches, `launchFee` alone for
  ERC-20 pairs. Off by one wei in either direction reverts with
  `NativeValueMismatch` (`0xbc760cfe`).
- **Declarable exemptions are 31, not 32** — verified by simulating `launchAndBuy`
  at 0/1/30/31/32/33 declared addresses: 31 succeeds, 32 reverts. The router
  appends `recipient` itself against a factory ceiling of 32. Re-checkable with
  `pnpm probe:exemptions`.

### What still has to race: the other 31 wallets

The curve does not exist until the launch transaction executes, so the remaining
whitelisted wallets cannot buy in the same transaction. **Block +1 is a physical
floor, not an optimisation target.**

This is where the danger is:

> A `buy` call to an address that has no code yet **does not revert**. The ETH is
> simply transferred and **stranded** at the curve's future address.

So buys must never be broadcast before the launch receipt is in hand. What can be
moved earlier is all the *computation*, not the wait.

---

## 3b. Four implementation details that decide success

These come from third-party field measurement on this chain and each one has a
documented failure mode behind it. None are optional.

**1. Fee cap, not gas price.** The launch transaction burns ~3.7M gas, which
raises the next block's base fee above whatever was read before launch. A bundle
priced on the pre-launch base fee fails *entirely and simultaneously* with
`fee cap cannot be lower than the block base fee`, and leaves no on-chain
transaction to diagnose. Use EIP-1559 headroom:

```text
maxFeePerGas = baseFee × 6 + tip
```

The cap is a ceiling, not a payment. If fees do not actually spike, the headroom
is free.

**2. Poll receipts at 100 ms.** viem's `waitForTransactionReceipt` defaults to a
4000 ms polling interval. On a 100 ms chain that single default can hold the
bundle longer than the entire 3-second window being contested.

```ts
createPublicClient({ transport: http(rpc), pollingInterval: 100 })
```

**3. Permutation-safe slippage floors.** N independent transactions are ordered by
the sequencer, not by STUNKS. If each wallet is priced assuming it goes first, the
wallet that actually lands last meets the worst price while carrying the most
optimistic floor, and reverts. Measured spread across 4 wallets is ~0.6% — enough
to trigger it.

Price every wallet **as if all the others already bought**. That is the worst case
for any ordering, so the floor is valid under all permutations. Only the atomic
mode may price sequentially, because there the order is deterministic.

**4. Leave a gas reserve in each recipient.** Reference values:

```text
gas reserve per wallet   0.0008 ETH
buy gas limit            300,000
approve gas limit         90,000
```

Without a reserve, a wallet ends up holding tokens it cannot sell because it has
no gas. That failure only surfaces when the user tries to exit, which is the worst
possible moment to discover it.

---

## 4. Two models — and only one is acceptable for STUNKS

This distinction is the most important product decision in the feature.

### Model 1 — one payer, N recipients  ✅ STUNKS builds this

One wallet — the creator's — pays for every buy, setting `recipient` to each
whitelisted address in turn.

- Only **one** private key is ever involved, and it stays in the user's wallet
- The other 30 addresses never sign anything and never need to hold ETH; they are
  delivery destinations only
- Works because the exemption keys on `recipient` (verified)
- Fully compatible with the non-custodial rule

### Model 2 — N wallets each buying for themselves  ❌ STUNKS does not build this

This is what external sniper bots do, and what "pre-signed" means in
`PONS-V2-BUNDLER.md`: 31 separate wallets, each signing its own transaction.

- Requires **31 private keys** available to the signer
- A web application cannot do this without taking key custody, which the project
  rules forbid outright
- STUNKS will not import, generate, store, or hold keys for this or any purpose

If a user genuinely wants Model 2, they need their own local tooling. STUNKS can
still help by preparing the launch and exposing the predicted curve address, but it
will not hold the keys.

### The honest tradeoff of Model 1

Model 1 is simpler, safer, and non-custodial. It is also **more visible**: one
payer funding N recipients is the easiest pattern for cluster-analysis tools to
read. STUNKS should not pretend otherwise, and should not market obfuscation.
Whitelist bundles are public calldata anyway (§5), so concealment was never
available.

Note: ERC-4337 EntryPoint v0.6, v0.7 and v0.8 are all deployed on Robinhood Chain,
so a future non-custodial multi-signer design is technically possible — each wallet
signs a UserOperation rather than handing over a key. That is a Phase 9+
consideration, not V1.

---

## 5. Honest limits

These must appear in the UI. Overpromising here is how the feature becomes a
liability.

- **The real edge is ~1 second, not 3.** Measured tax falls from ~99% at age 0 to
  6.2% at age 1 and 0.19% at age 2. Marketing this as "3 seconds of protection"
  would be false. The honest claim is: whitelisted wallets can buy in the launch
  block at zero tax, while others must wait for the tax to decay.
- **Not a guarantee of being first.** A non-exempt sniper can still buy at ~99%
  tax. Their ETH still enters the curve and still moves the price, so a
  whitelisted buyer who waits gets a worse fill. STUNKS should submit the bundle
  as fast as possible and show the achieved price, not a promised one.
- **32 is the contract ceiling and 31 is what you may declare** through the
  router, which appends `recipient` itself. **Verified first-hand by simulation**
  (`pnpm probe:exemptions`): 31 declared addresses is accepted, 32 reverts. STUNKS
  caps input at 31 and explains why, rather than letting the transaction revert
  after the launch fee is already committed.
- **Broadcasting a buy before the launch receipt loses the money.** A `buy` to an
  address with no code does not revert; the ETH is stranded at the curve's future
  address. This must be structurally impossible in the code, not merely avoided.
- **Pair asset may be a tokenized stock, and decimals vary.** USDG uses **6**
  decimals. Never assume 18. Read `pairTokenEconomics(pairToken)` for that pair's
  own `phantomQuote` and `graduationThreshold`; five pairs have non-round
  full-precision values that cannot be derived from a ratio.
- **The whitelist is immutable after launch.** It is written during
  `launchToken`. There is no add-later path. The UI must make this unmistakable
  before signing.
- **The window is `snipeTaxSeconds`, currently 3 and owner-mutable** (source says
  15, chain says 3). Read it live from the curve at bundle time and never
  hardcode it.
- **Quoting inside the window must use `eth_call` simulation**, because the decay
  formula is still unverified. Do not compute the tax locally.
- **Pair token may be an ERC-20**, including a tokenized stock. Those launches
  need an approval before buying, which adds a transaction and eats into the
  window. Approve before launching, not after.

---

## 6. Anti-abuse position

This feature makes bundled opening buys easier, which is exactly what Pons's own
exemption list is designed to sanction — the source calls it "the sanctioned
pathway for organized teams that bundle their opening buys". STUNKS is not
circumventing a protocol protection, it is using a documented one.

Consequences STUNKS must still own:

- Whitelisted wallets of a launch are recorded and **excluded from trading
  competition volume** for that token, so the feature cannot farm leaderboards.
- Token pages disclose that a launch used a whitelist bundle, and how many
  recipients. Traders deserve to know the opening distribution was concentrated.
- Holder-distribution analytics must flag bundle concentration rather than hide it.

---

## 7. Verification status

Done:

1. `MAX_SNIPE_TAX_EXEMPTIONS = 32` read from the factory source and consistent
   with the deployed factory.
2. Exemption keys on `recipient`, not `msg.sender` — proven by four-way
   simulation at an in-window block.
3. The explicit `snipeTaxExemptions[]` array registers arbitrary third-party
   addresses — confirmed on a real launch where
   `snipeTaxExempt(whitelistedAddress) == true` for an address that is neither the
   deployer nor the creator fee recipient.
4. Decay curve measured at ages 0–4 s.
5. Almost nobody uses this today: 1 non-empty whitelist out of 185 recent launches.

Still to verify before shipping:

1. Exact decay formula, so the UI can show expected tax over time rather than
   measured samples.
2. Real bundle latency end to end: launch receipt → buy inclusion, measured on
   mainnet with a small-value test launch.
3. The approved pair-token list, before offering stock-paired launches.
4. Whether the whitelisted recipient needs to already exist / hold ETH. It should
   not, since it only receives tokens, but this must be confirmed with a real
   fresh address.
