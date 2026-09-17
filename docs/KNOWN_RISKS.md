# STUNKS.FUN — Known Risks and Open Unknowns

**As of:** 2026-09-15, after Phase 0 verification against Robinhood Chain mainnet.

Severity: **C**ritical / **H**igh / **M**edium / **L**ow.

---

## R1 — C — Published Pons V2 source does not match deployed bytecode

The GitHub repository `ponsdotdev/ponsfamily` is internally inconsistent.
`PonsV2LaunchFactory.sol` calls `PonsV2BondingCurve(curve).exemptFromSnipeTax(...)`
in three places, but `PonsV2BondingCurve.sol` in the same commit contains **zero**
occurrences of `snipeTax`. That source set cannot compile.

The deployed curve does have the subsystem — five selectors confirmed present in
runtime bytecode (`PONS_V2_INTEGRATION.md` §8). Independently,
`snipeTaxSeconds` reads `3` on-chain while the source hardcodes `15`.

**Impact:** any behaviour derived from reading the repo may be wrong. This
includes fee math, revert conditions, and event parameters.

**Mitigation:** chain and bytecode are the source of truth. `packages/pons` ABIs
are assembled from verified selectors, not copied from the repo. `verify-pons.ts`
re-checks the documented facts in CI.

**Residual:** the verified source for the deployed curve could not be retrieved
from this network (Blockscout returns Cloudflare 403). Until it is, revert
reasons and the snipe-tax formula remain partly opaque. **Retrieve the verified
source from an unfiltered network before Phase 5.**

---

## R2 — H (was C) — Snipe tax up to 99% in the opening second

Deployed curves apply a decaying anti-snipe tax: `snipeTaxStartBps = 9900`,
`snipeTaxSeconds = 3`, per-curve, evaluated **per recipient**, with an exemption
list fixed at launch.

Downgraded from Critical because the mechanism is now pinned from two independent
directions: measured by simulation (~98.94% / 6.20% / 0.19% / 0% at ages 0–3 s) and
matched exactly by the documented bit-shift formula
`startBps >> floor(elapsed*14/seconds)`. The curve also exposes
`currentSnipeTaxBps(address)` directly.

**Impact:** a quote computed without the tax in the first second is wrong by ~100x.

**Mitigation:** read `currentSnipeTaxBps(recipient)` from the curve and confirm
with `eth_call` simulation. Do not reimplement the shift. Off-chain fast-path math
is used only once `block.timestamp - launchedAt >= snipeTaxSeconds`.

---

## R17 — C — A buy broadcast before the launch receipt loses the funds

A `buy` call to the curve's predicted address before the launch transaction
executes **does not revert**. The value is transferred to an address with no code
and is stranded there permanently.

This is the sharpest edge in the whole Protected Launch feature, because the entire
performance strategy is built on preparing and signing buys in advance.

**Impact:** direct, silent, unrecoverable loss of user funds.

**Mitigation:** make it structurally impossible rather than merely avoided. The
broadcast function must take the launch receipt as a required argument, and no code
path may hold a signed buy and a send capability without one. Covered by an
explicit test that asserts a pre-receipt broadcast is rejected locally.

---

## R18 — H — The launch transaction spikes the next block's base fee

The launch burns ~3.7M gas, lifting the following block's base fee above whatever
was read during preparation. A bundle priced on the pre-launch base fee fails
**entirely and at once** with `fee cap cannot be lower than the block base fee`,
and produces no on-chain transaction to diagnose.

**Impact:** total, silent bundle failure at the exact moment it matters, after the
launch fee has already been paid.

**Mitigation:** EIP-1559 headroom, `maxFeePerGas = baseFee × 6 + tip`. The cap is a
ceiling, not a payment. Also: viem's 4000 ms default receipt polling must be set to
100 ms, or the client alone can outlast the 3-second window.

---

## R14 — H — Protected Launch could be over-marketed

The whitelist edge is real but narrow: it is a ~1-second head start, not "3
seconds of sniper protection". By age 2 s a sniper pays 0.19%, so a bundle that
lands late delivers no advantage at all while still having promised one.

**Impact:** users pay for and trust a feature that silently fails to deliver when
latency is bad. That is a reputational and arguably a fairness problem.

**Mitigation:** report achieved age and achieved price per recipient after every
bundle, never a promised one. Copy describes a launch-block advantage, not a
protection window. Option B (atomic bundler) is treated as required for the
feature to be honest at scale, not as an optional upgrade.

---

## R15 — M — Protected Launch concentrates opening supply

The feature makes bundled opening buys easy, and Pons explicitly sanctions the
mechanism. It still means up to 32 wallets plus the creator can take the opening
allocation before ordinary buyers get a fair price.

**Impact:** if STUNKS hides this, the platform is helping conceal concentrated
distribution from later buyers.

**Mitigation:** token pages disclose that a launch used a whitelist bundle and how
many recipients; holder-distribution analytics flag concentration rather than
smoothing it; whitelisted wallets are excluded from that token's competition
volume so the feature cannot farm leaderboards.

---

## R16 — M — `StunksBundleBuy` would be the first STUNKS contract holding user value in flight

Option B routes user ETH through a STUNKS contract within a single transaction.
Even stateless, a bug means lost funds.

**Impact:** direct financial loss, and it is the one place STUNKS stops being a
pure interface.

**Mitigation:** stateless by construction, no owner, no upgrade path, no storage
of balances, full refund of remainder in the same call, reentrancy-guarded,
covered by fork tests, and audited before mainnet. Ship Option A first so the
product works without it.

---

## R21 — RESOLVED — Indexer throughput was below the chain's block rate

**Resolved.** Re-measured after batching the launch writes:

```text
chain produces          ~10 blocks/second
indexer before           2–7 blocks/second   (could never catch up)
indexer after           ~100 blocks/second   (median of 6 consecutive windows)
```

Sustained ~100 blocks/second is 10x the chain's production rate, so the indexer both
catches up and stays current. Evidence: token count went from 716 to **5,163** and
trade count from **0 to 552** in roughly six minutes of wall-clock running, with all
integrity checks still passing.

The original measurement and the diagnosis that followed it are kept below, because
one of the conclusions was wrong and that is worth recording.

### What the original diagnosis got wrong

The remaining bottleneck was attributed primarily to **network latency to a remote
serverless Postgres**, with co-location named as the main remedy and batching listed
second. That ordering was wrong.

The cost was not latency per round trip, it was the **number of round trips**: a
transaction per launch, at roughly 13 launches per 226 blocks. Batching a whole scan
window into three round trips removed ~97% of them and fixed the problem outright from
a developer machine on another continent, with the database still in `us-east-2`.

Co-location is still worth doing and the deploy config exists for it
(`apps/indexer/Dockerfile`, `apps/indexer/fly.toml`), but it is now an optimisation
rather than a prerequisite. **U13 is closed:** the question of whether a co-located
indexer could sustain >10 blocks/second is moot, because a non-co-located one sustains
~100.

Two bottlenecks were found and partly fixed:

1. **~20 sequential contract reads per launch** (launch record, token metadata, full
   curve state, pair decimals). Fixed by enabling Multicall3 batching on the indexer
   client — Multicall3 is deployed at the canonical address on this chain. This was a
   large improvement but not sufficient.
2. **Two database round trips per launch.** The opening price/reserve write was folded
   into the same insert as the launch record, halving them.

What remains is dominated by **database latency to a remote serverless Postgres**
(~2.7s per launch observed at peak). Launches arrive at roughly 13 per 226 blocks on
this chain, which is an extraordinary rate.

### The fix

`LaunchBatchRepository.recordLaunches` in `@stunks/database` collapses one scan window
into three round trips regardless of how many launches it contains: read which creators
exist, `createMany` the missing ones, `createMany` the tokens. `skipDuplicates` keeps it
idempotent, which matters more than the speed — an overlapping window or a replayed
batch must not double-write.

**Trade-off accepted:** creator `tokenCount` is no longer incremented inside a
transaction per launch. It is recomputed from the token table by
`refreshCreatorCounts`, which is self-healing after a replay rather than permanently
inflated by one.

### The curve stream had the same bug, and it was worse

Fixing the factory stream exposed that the curve stream was not merely slow, it was
**stalled**: one 126-block tick in six minutes (~0.35 blocks/second) while the factory
stream ran at ~100. The cause was the same shape of mistake in three places:

1. one `findByCurve` per newly-seen curve address in the window
2. one `trades.record()` per trade — a findUnique plus a create, so two round trips each
   — while a `recordMany` already existed and went unused
3. `refreshTokenStats` awaited sequentially per touched token, each costing ~6 round
   trips (find token, three aggregates, a chain read, an update)

At ~100 tokens touched per window that was ~600 sequential round trips before the window
could close.

Fixed with `TradeBatchRepository` and `TokenBatchRepository`: one query resolves every
curve to its token, one `createMany` inserts every trade, and stats are recomputed for
the whole set with a fixed number of queries (two `groupBy` calls plus one `DISTINCT ON`
for the per-token latest trade) with the curve reads issued concurrently.

Re-measured: **0.35 -> 15-26 blocks/second**, inserting ~900 trades per tick. Trade count
went from 552 to **7,861**.

The curve stream is slower than the factory stream because it processes far more logs per
window (~1,268 vs ~150). It is still above the chain's ~10 blocks/second, so it converges,
but a large backlog takes hours rather than minutes to clear.

**Lesson worth keeping:** I fixed one stream, measured it, declared the risk resolved, and
was wrong — the other stream had the identical defect and I had not looked. Measuring the
component you just changed is not the same as measuring the system.

### Current state

- factory stream: at the head, ~52 blocks (5 s) lag, checkpoint clean
- curve stream: ~15-26 blocks/second with a ~147k block backlog still to clear

**Still true:** verify throughput in the actual deployment environment before calling the
indexer production-ready. The numbers above were measured on a developer machine, and a
different environment is a different measurement.

---

## R22 — RESOLVED — The curve stream scanned from the factory deploy block

The curve stream starts at the same block as the factory stream and scans forward
looking for `CurveBuy` / `CurveSell` from the curves it knows about. Since curves only
exist from their own launch block onward, every block before the earliest known launch
is guaranteed to contain nothing for it.

Observed: the curve stream scanning from block 26,842,730 at ~233 blocks/second with
zero matching logs, which would take ~44 hours to reach the head.

**Resolved.** `CheckpointRepository.fastForward` moves the curve checkpoint to
`earliestLaunchBlock - 1` at startup. It is deliberately a separate method from
`advance()`: advancing means "these blocks were processed", fast-forwarding means
"these blocks were skipped, and here is why". They record different facts, and the
block hash is left null for a skip because none was verified.

**Bug found and fixed while verifying this.** The fast-forward was originally called
from inside the curve scanner's `maxBlock` callback, so it ran on every tick. Once the
curve stream overtook `earliestLaunchBlock`, the callback asked `advance` to move the
checkpoint backwards and the guard rejected it every tick:

```text
Refusing to move checkpoint backwards for curves: at 63775020, asked to set 26855360
```

Non-fatal, because the error was caught per tick, but it wasted a tick each time. The
call now happens once at startup, before scanning begins. The lesson worth keeping: a
guard firing repeatedly is a signal that a caller has the wrong lifecycle, not that the
guard needs relaxing.

---

## R23 — H — A sequential two-stream backfill deadlocks on this chain

The first design ran the factory stream to completion, then the curve stream. Because
the indexer is slower than the chain head (R21), the factory backfill never completed
and the curve stream **never started at all**. The observable symptom was 716 tokens
indexed and zero trades — a state that looks like a decoding bug but was a scheduling
bug.

**Fixed.** Both streams now run concurrently, with the curve stream capped at the
factory checkpoint via `Scanner.maxBlock`. That preserves the real requirement — a
trade needs its token to exist first — without requiring the factory to ever be
"done".

The lesson generalises: on a chain that outruns the indexer, any "phase A to
completion, then phase B" schedule is a deadlock.

---

## R3 — H — Indexer backfill is infeasible on public RPC

Measured: 0.1013 s/block, ~852,912 blocks/day. V2 factory deployed at block
26,841,846; head 63,444,974 → **36.6M blocks** to backfill. Free endpoints cap
`eth_getLogs` at small spans (~100 blocks succeeded, 500 rejected) and rate-limit
to roughly 2 req/s → **10+ hours of pure RPC for a single address filter**, before
per-curve trade filters multiply it.

**Impact:** Phase 3 cannot be built on public RPC.

**Mitigation:** decide the data source before writing the indexer. Candidates:
paid archive RPC with wide `getLogs` (Alchemy, Chainstack, dwellir all advertise 4663) or Envio HyperSync, which documents Robinhood Chain support.

**Unverified:** HyperSync coverage for 4663 has not been probed. Do that first.

---

## R4 — H — `Swept` is a tradeable-looking state with no venue

Graduation is two-phase and `_tryAutoGraduate()` deliberately swallows failures,
emitting `AutoGraduationFailed`. A token can rest in `Swept`: curve drained,
trading halted, V4 pool not yet created.

**Impact:** a venue resolver that only asks "graduated?" will route users into
transactions that always revert.

**Mitigation:** the resolver handles all four phases explicitly and `Swept` and
`Rescued` return no venue. UI disables trading with a specific explanation. This
is covered by unit tests in Phase 1.

---

## R5 — H — Partial fills on the final buy of every launch

`buy` clamps to `reservedTokens` rather than reverting, refunds the surplus, and
**reinterprets `minTokensOut` as a price bound instead of a quantity bound**.

**Impact:** a UI that treats `minTokensOut` as guaranteed quantity will misreport
the last trade of every single launch, and any naive "you will receive exactly X"
copy will be wrong.

**Mitigation:** parse `CurveBuy` plus `CurveBuyRefunded` from the receipt and
report actual spend and actual output. Preview copy says "up to".

---

## R6 — H — STUNKS has no fee revenue path

Verified live policy: `protocolFeeShareBps 3000`, `buybackBurnBps 5000`,
`hookFeeBps 100`, recipient `0x263ed295…19Dd`. Nothing routes value to STUNKS.
Routing trades through a third-party interface earns that interface nothing.

**Impact:** any revenue projection assuming a share of Pons fees is unfounded.

**Mitigation:** V1 reports platform revenue as zero. `FeeAdapter` remains a
read-only analytics interface. No `StunksFeeAdapter` is deployed until a real
routing mechanism is verified to exist.

---

## R7 — M — Two reserve getters, easy to confuse, silent when wrong

`getReserves().quoteReserve` includes `phantomQuote` and is the **pricing**
reserve. `realQuoteReserve()` excludes it and is the **graduation-progress**
reserve. At launch the first reads 1.68 ETH and the second reads 0.

**Impact:** swapping them produces plausible but wrong prices or a progress bar
that starts at 40%.

**Mitigation:** the two are separate named concepts in `packages/pons` with
distinct return types, never interchangeable, and covered by tests.

---

## R8 — M — Owner-mutable protocol parameters

`launchFee`, `launchEnabled`, `maxCreatorTaxBps`, `snipeTaxStartBps`,
`snipeTaxSeconds`, launch configs, the graduation executor, launch deployer, and
launch forwarder are all owner-mutable. Owner is an EOA,
`0x263ed295dAFaE1d9AAdD6E56c4B6F9f38eE019Dd`, which is also the protocol fee
recipient. Owner-only rescue paths exist (`forceSweptGraduation`,
`rescueCurveFees`, `rescueSweptGraduation`).

**Impact:** cached values go stale silently; a launch signed against old terms
could execute against new ones.

**Mitigation:** read parameters live with short TTLs; resolve addresses from the
factory rather than config; always pass `expectedEconomics` from
`previewLaunchEconomics`. Per-launch `FeePolicySnapshot` limits retroactive
change, and STUNKS displays each token's snapshot, not the global policy.

---

## R9 — M — Local development environment incomplete

Node 26.7.0, pnpm 9.12.0, git 2.50.1 present. Docker, `psql`, and Foundry
(`cast`) are **not** installed. The workspace is not a git repository.

**Impact:** Postgres and Redis cannot be provisioned locally yet; no contract
tooling for local forks.

**Mitigation:** Phase 1 initialises git and provides `.env.example`; the database
target (local install vs Docker vs hosted dev instance) needs a decision from you.

---

## R19 — M — Part of this specification rests on third-party documentation

`PONS-V2-BUNDLER.md` supplied several facts now embedded in the design: the decay
formula, the 11 approved pairs, the 31-exemption router limit, the base-fee spike,
the stranded-ETH footgun, and measured bundle latency.

Every claim that could be checked against the chain was checked and matched:
`launchAndBuy` selector, `pairTokenEconomics` values for five pairs including
MSFT's full-precision figures, `currentSnipeTaxBps(address)` presence,
`approvedPairTokens`, the RPC, and the decay formula against prior independent
measurements. That track record is good.

Two claims did **not** verify: `MAX_DECLARED_EXEMPTIONS()` is not a public getter,
and the robinscan `/api/contracts/{address}` endpoint returned 404 from this
network, so it did not resolve R1 as hoped.

**Impact:** the unverifiable remainder — chiefly the 31-exemption limit and the
measured latency figures — is assumed on someone else's authority.

**Mitigation:** treat the 31 cap as provisional and confirm by simulation before
spending a launch fee (U11); re-measure latency on STUNKS' own path (U8). Do not
copy any number from that document into code without a `verify-pons.ts` check
behind it.

---

## R10 — M — Network-level DNS interception on this machine

`robinhood.com` resolves here to `internetpositif.id` (`36.86.63.185`), an ISP
content filter, breaking the official RPC and the docs site. Blockscout returns
Cloudflare 403.

**Impact:** the official RPC and explorer API cannot be used or verified from
this environment; it also means TLS to those hosts is being intercepted.

**Mitigation:** verification used `robinhood.drpc.org` and
`rpc.nodeflare.app/robinhood/public`, both confirmed on chain ID 4663. Production
config should still prefer the official endpoint. **Re-run verification from an
unfiltered network** to retrieve verified sources and confirm the official RPC.

---

## R11 — M — Reorg semantics on an Arbitrum Orbit L2 are unspecified here

The indexer must be reorg-safe, but the practical reorg depth for Robinhood Chain
is not documented in anything verified. At ~0.1 s blocks, a conservative
confirmation depth costs little latency in wall-clock terms.

**Mitigation:** store block hashes alongside checkpoints, verify parent-hash
continuity, roll back on mismatch, and make confirmation depth configurable.
Determine the empirical depth during Phase 3.

---

## R12 — L — Experimental, undeployed contracts in the Pons repo

`contractsV2/src/v2/hooks/PonstakingV2_test/PonsV2Staking.sol` and
`contractsV2/src/v2/testing/PonsDividends.sol` are experimental and not part of
the deployed system. The repo also contains unrelated `.md`/`.jpg` files planted
inside vendored library directories (`ozz.md`, `toto.md`, `truth.md`); these were
inspected and are author easter eggs, not code and not instructions.

**Impact:** integrating either contract would build on something that does not
exist on chain.

**Mitigation:** `packages/pons` covers only contracts verified as deployed.

---

## R13 — L — High launch throughput

Two `TokenLaunched` events appeared within a 100-block (~10 s) window at audit
time. Real throughput is unmeasured but non-trivial.

**Impact:** Explore, trending, and moderation must cope with a high rate of new
tokens, most of them low quality or spam.

**Mitigation:** cursor pagination everywhere, trending resistant to trivial
manipulation, and moderation states from day one.

---

## Open unknowns

| #       | Question                                                                    | Blocks                                                                                | Verify by                                             |
| ------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| U8      | Real bundle latency for STUNKS' own path: launch receipt → buy inclusion    | whether Protected Launch delivers its advantage                                       | small-value mainnet test launch with a real whitelist |
| ~~U13~~ | ~~Whether a co-located indexer sustains >10 blocks/second~~                 | CLOSED — moot. Batched writes reached ~100 blocks/second _without_ co-location (R21). | —                                                     |
| U10     | Where the collected snipe tax goes (protocol / creator / buyback / reserve) | fee analytics and honest mechanism copy                                               | verified source, or trace a taxed buy's value flow    |
| U12     | Exact composition of deductions once they exceed 100% (age 0 of a launch)   | nothing — quotes there come from simulation                                           | verified source, or a controlled fresh launch         |

**Resolved since first draft**

| #   | Was                                     | Resolution                                                                                                                                                                                                      |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Exact snipe-tax decay function          | `startBps >> floor(elapsed*14/seconds)`, matching independent measurements; and `currentSnipeTaxBps(address)` exists on-chain, so it is read rather than computed                                               |
| U3  | Envio HyperSync coverage for 4663       | **Supported.** `/height` returns a value tracking the chain head (measured lag ~113 blocks). Queries need a free token from app.envio.dev. Implemented as a pluggable source; `pnpm probe:sources` re-checks it |
| U9  | Approved pair-token list                | `pairTokenEconomics(address)` and `approvedPairTokens(address)` verified present; five pairs re-read and matched exactly. USDG is 6 decimals                                                                    |
| U11 | The router's declarable-exemption limit | **31, verified first-hand.** `pnpm probe:exemptions` simulates `launchAndBuy` at 0/1/30/31/32/33 declared addresses: 31 succeeds, 32 reverts. Encoded as `MAX_DECLARABLE_SNIPE_EXEMPTIONS` with tests           |
| —   | "Launch and buy cannot be atomic"       | **Wrong.** `PonsV2LaunchAndBuy.launchAndBuy` (`0xf85f8e41`) is public and in active use; the creator's own buy is atomic and unfront-runnable                                                                   |

---

## R20 — H — The whitelist cap is enforced only after the launch fee is taken

Verified by simulation: the router accepts 31 declared exemptions and reverts at 32.
The revert happens inside the launch call, which means the launch fee
(0.0005 ETH at audit time) has already been committed.

**Impact:** a creator who supplies one address too many loses the fee and has to
start over, with nothing to show for it.

**Mitigation:** `validateSnipeExemptions` in `@stunks/pons` enforces the cap
client-side before signing, and its error message states both the limit and why
exceeding it costs money. It also frees slots taken by the auto-exempt deployer and
by duplicates, so the user is not pushed over the cap by entries that were never
needed. Covered by tests.
| U2 | Uniswap V4 quoter/router availability on 4663 | graduated-token trading (Phase 5) | probe V4 periphery addresses; replay a real swap |

| U4 | Fee escrow event signatures | creator earnings (Phase 7) | verified ABI or topic matching on escrow logs |
| U5 | `poolFee = 0` semantics with the hook's dynamic fee | price-impact accuracy post-graduation | read a graduated pool's state and compare |
| U6 | Empirical reorg depth on Robinhood Chain | indexer confirmation depth (Phase 3) | observe head churn over time |
| U7 | Does deployed factory bytecode match published source overall? | trust in all source-derived behaviour | fetch verified source from an unfiltered network |

No implementation will assume a value for any of these.

---

## R24 — H — A bundle buy is not atomic, and cannot be made atomic

The whitelist bundle sends one `curve.buy(amount, minOut, recipient)` per whitelisted
wallet, sequentially, from a single funded payer. Sequential submission from one wallet
gives sequential nonces, so ordering holds _within_ that wallet — but the bundle is not
atomic with the launch and not atomic with itself. An outsider's transaction can
interleave, and any individual buy can revert while its neighbours succeed.

**What this rules out:** the honest description of this feature is never "all your
wallets buy at the launch price". It is "your wallets buy without the anti-snipe tax,
in order, as fast as one wallet can submit".

**Mitigations implemented:**

- **Permutation-safe floors.** Every buy's `minOut` is priced as if every _other_ buy
  in the bundle landed first (`worstCaseFloors` in `packages/pons/src/trade/bundle.ts`).
  A floor priced on the planning-time reserve would make the first buy move the price
  and every later buy revert on its own slippage check — a bundle that half-executes and
  looks like a bug. Proven by a test that replays the plan in reverse order and asserts
  every floor still clears.
- **Per-wallet result reporting.** The UI reports each wallet's outcome separately, with
  `unknown` as a distinct state from `failed`. A transaction whose receipt could not be
  retrieved is never described as failed; the wallet may still have it.
- **Honest cap warning.** Above ~8 wallets the later buys will land after the ~3 s
  window. They still pay no tax (they are exempt) but they buy at a price other traders
  have already moved. The form says this before the user commits.

**Not mitigated:** if the payer wallet is front-run between the launch and the first
bundle buy, the bundle buys at a worse price. Nothing in the protocol prevents this.

**Unresolved (U8):** actual latency from launch receipt to first bundle buy landing has
never been measured on mainnet. It requires a real launch with real ETH. Until then, how
many wallets genuinely fit inside the window is an estimate, and the warning threshold of
8 is a conservative guess rather than a measurement.

---

## R25 — C — A buy sent to a not-yet-deployed curve silently destroys the funds

Verified behaviour, and the single most dangerous property found in this protocol: a
`buy` call carrying value to an address with **no code does not revert**. It succeeds as
a plain value transfer to a codeless account. The ETH is not recoverable.

This matters specifically because the curve address is deterministic and _could_ be
predicted before launching. Predicting it would shave a round trip off the bundle path,
which is tempting when the whole feature is a race against a 3-second window.

**Mitigation — structural, not procedural.** `buildBundleTransactions` cannot be called
without a `ConfirmedLaunch`, and the only sanctioned way to obtain one is
`confirmedLaunchFromReceipt`, which requires a mined receipt containing a `TokenLaunched`
log emitted **by the configured factory**. The caller must additionally confirm the curve
holds code, and `buildBundleTransactions` throws if `curveHasCode` is false.

Three layers, deliberately:

1. no curve address exists in the plan until a receipt supplies one
2. the log must come from the configured factory, so a look-alike event from an
   attacker's contract cannot redirect the bundle
3. code presence is checked against the chain, because a receipt proves a transaction
   mined, not that it mined on the canonical chain after a reorg

Covered by tests, including the refusal path.

---

## R26 — M — STUNKS refuses to trade graduated tokens

Once a launch reaches `PoolCreated`, trading moves to a Uniswap V4 pool governed by the
Pons meme hook. STUNKS refuses these trades outright rather than routing them.

**Why refuse rather than approximate:** the hook takes a cut in `beforeSwap`/`afterSwap`,
and the V4 quoting path on this chain is unverified (U2). A constant-product estimate
would misprice the trade, and a wrong number about someone's money is worse than no
number.

**User impact:** a graduated token shows an explanation and a pointer to a V4 interface,
not a trading panel. This is a real product gap, stated plainly rather than hidden behind
an estimate.

**Resolution path:** close U2 by probing V4 periphery addresses on 4663 and replaying a
real swap against a graduated pool. Until then the refusal stands.

---

## R27 — H — Integration test must never share the mainnet index namespace

**Incident (development database, 2026-09-15):** the repository integration suite used
chain ID `4663`, the real Robinhood Chain ID. Its reorg-recovery test correctly called
`deleteAboveBlock(4663, 150)`, but because the database also contained real indexed
mainnet trades, that operation deleted all trades above block 150 — roughly 51,000 rows
at the time. The chain was never touched; tokens and creators remained, and every lost
trade can be recovered from chain history. The database's indexed trade history was not
safe, however.

**Root cause:** the test fixture was isolated only by marker fields on rows it created.
`deleteAboveBlock` intentionally operates at chain scope because that is exactly what a
real reorg rollback needs. It cannot safely be restricted to a fixture marker in
production code. The fixture therefore chose the wrong isolation boundary.

**Mitigation implemented:** database integration fixtures now use the synthetic chain ID
`9_999_999`, which cannot overlap with a real configured chain. The reorg test still
exercises the real chain-scoped deletion semantics, but only inside its own namespace.

**Recovery choices for the affected development database:**

1. Restore Neon to a point before the test, if point-in-time recovery is enabled. This
   is fastest and preserves the prior index exactly.
2. Rebuild the curve-trade stream from on-chain logs using HyperSync. This is
   authoritative, but needs a free Envio token and a controlled curve-checkpoint rewind.
   RPC-only replay from the first launch was measured in days, not minutes.

**Do not** merely set the curve checkpoint to head or fabricate aggregate values. The
blockchain is the source of truth; a partial history presented as complete would be a
new, worse data error. A replay changes many database rows and consumes RPC/HyperSync
capacity, so it requires explicit operator approval.

### Recovery outcome (development database, 2026-09-16)

Neon point-in-time restore to `2026-09-15T21:30:00Z` (04:30 Asia/Pontianak) was
verified before restoring with a historical query: **37,088** `trades` rows for chain 4663. After restore, read-only integrity checks found zero orphaned trades.

The historical snapshot had 1,217 trades whose block number was ahead of the curve
checkpoint — a normal snapshot race, where idempotent rows were written just before the
checkpoint transaction. The current indexer replayed that overlap safely, then advanced
past it: the active database reached **42,910** trades and zero trades above the curve
checkpoint. No trade was duplicated.

Seven old failed-block rows were all below checkpoints that had already advanced. The
scanner now resolves failed rows through every successful checkpoint, so the health
endpoint returned `ok` with zero unresolved failures after the replay.

---

## R28 — RESOLVED — Freshness was reported from the wrong stream

**What it claimed vs what was true (2026-09-17).** The staleness banner on the landing
and explore pages read the **factory** stream's checkpoint. Every price, market cap,
volume figure and trade count on those pages comes from the **curve** stream.

| Stream  | Behind head    | In time    |
| ------- | -------------- | ---------- |
| factory | 361 blocks     | 37 seconds |
| curves  | 715,288 blocks | ~20 hours  |

So the page reported "37 seconds behind" over figures that were a day old.

**Why it was structural, not a typo.** The curve stream is _capped_ at the factory
checkpoint by design, so it can only ever be equal or behind. Picking the factory stream
was therefore guaranteed to report the optimistic number, permanently, and the gap grows
with the backlog rather than shrinking.

This is a direct violation of invariant 4. The invariant is not only about fabricated
values — a real number presented as fresher than it is misleads in the same way.

**Fix.** `apps/web/src/lib/staleness.ts` is a pure module whose rule is that freshness is
the **slowest** required stream. Both streams are reported individually so the banner can
name where the backlog is, a paused stream counts as stale regardless of its block
number, and a missing stream reports "unknown" rather than "current". Nine tests pin it,
including the exact 2026-09-17 numbers above. Moving the rule out of the database module
is what made testing it possible at all.

---

## R29 — RESOLVED — Reorg rollback deleted across streams but rewound only one

**The coupling.** `handleReorg` deleted `trades` and `tokens` at **chain** scope, then
rolled back only the checkpoint of the stream that detected the divergence.

Because the curve stream trails the factory — 715,288 blocks on 2026-09-17 — a rollback
there would delete every token the factory had already indexed above the rollback point,
while the factory checkpoint stayed put and therefore **never re-scanned them**. Those
launches would be gone permanently, and their later trades would fail to resolve and be
counted as `unmatched`.

The trigger does not require a real reorg. `handleReorg` fires on a hash mismatch, and
the pool routes consecutive `blockHash` reads to whichever endpoint is currently ranked
first — so one endpoint answering with a different hash is enough.

**Fix.** Each stream now deletes only the rows it writes, through a `deleteAbove`
callback: the factory owns tokens (trades follow via `onDelete: Cascade`), the curve
stream owns trades and must never touch tokens. A `cascadeStreams` list then pulls back
any stream the deletion left standing above the rollback point, via
`rollbackIfAhead` — which is a no-op for a stream already below it, so a stream far
behind the divergence is never dragged backwards for nothing. Seven tests cover the
ordering, the cascade, and both non-rollback cases.

---

## R30 — RESOLVED — The verification harness aborted on the first RPC error

`pnpm verify:pons` ran its eight sections as a plain sequence of awaits. On 2026-09-17 it
did not complete against either public endpoint:

- dRPC rejected `eth_getCode` at the factory's deploy block — "Unknown state. First
  available state is 1" — aborting at section 2 of 8.
- OrdoFi could not return the head block it had itself just reported, aborting at
  section 1.

So roughly thirty checks that need only current state did not run, and the README's
"35 checks, 0 failed" was no longer reproducible. A harness that stops at the first
endpoint quirk cannot detect the drift it exists to detect.

**Fix.** Sections are wrapped so one failure is contained, and a check that cannot be run
reports a third outcome — neither PASS nor FAIL. Exit code 2 distinguishes "could not
fully verify" from "a documented fact changed" (1). Against a pruning endpoint the run is
now **34 checks, 0 failed, 1 unverifiable**, the unverifiable one being the archive-state
deploy-block check.

---

## R31 — RESOLVED — The health endpoint listened on every interface

`startHealthServer` called `server.listen(port)` with no host, which binds `0.0.0.0`.
Confirmed on a running instance: `TCP *:9490 (LISTEN)`.

Both the compose file and the systemd unit carried a comment saying the endpoint was
localhost-only. Compose was right by accident — the `127.0.0.1:9464:9464` mapping did
it — but the systemd path has no such mapping and only set `HEALTH_PORT`. A port number
never restricted a binding. On that path the endpoint, which reports checkpoints, RPC
endpoint URLs and failure counts with no authentication, was reachable on the VPS's
public IP.

**Fix.** The server binds `127.0.0.1` by default, overridable through `HEALTH_HOST` for
the one legitimate case — inside a container, where loopback is unreachable from the host
and the port mapping provides the same isolation. The indexer logs a warning when it is
bound beyond loopback.

---

## R32 — RESOLVED — Four critical RCE advisories sat in the lockfile

`next@15.1.3` carried four critical advisories, including unauthenticated remote code
execution in Image Optimization and in the React flight protocol, plus a middleware
authorization bypass. Both surfaces were live: `next/image` is used on the landing page
and `sharp` was installed.

For a wallet dApp this is the worst class of bug available. Server-side code execution in
the app that renders the trading UI lets an attacker change the `to`, `data` and `value`
a user is asked to sign, and the wallet will present whatever it is handed.

**Fix.** `next` to 15.5.25, plus `pnpm.overrides` for `postcss` (>=8.5.18) and `ws`
(>=8.21.0), which are transitive and could not be reached by the bump. Production
advisories went from 49 (4 critical, 16 high) to 7 (0 critical, 0 high). The remainder
all arrive through wagmi's WalletConnect and MetaMask connector chain, which this app
does not configure — it registers `injected` only.

**Why it went unnoticed:** nothing ran `pnpm audit`. CI now runs it weekly and fails on
high or above, so an advisory published after a green merge still surfaces.

---

## R33 — RESOLVED — The invariants were enforced only by memory

There was no CI. The lint rules that ban `Number()`/`parseFloat()` in money paths and
address literals outside `@stunks/config`, and the tests pinning the curve maths and the
venue resolver, all ran only when someone remembered locally.

Two consequences were already in the tree:

- `apps/web` had no `test` script, so `turbo run test` skipped it entirely and
  `src/app/launch/launch-plan.test.ts` — which checks the launch funding arithmetic,
  money — had never executed in any run of `pnpm test`.
- `pnpm format:check` failed on 39 files and `prisma format` produced a 31-line diff,
  so neither check could have been trusted as a signal.

**Fix.** `.github/workflows/ci.yml` runs typecheck, lint, tests, formatting, the Prisma
schema check and the build on every push and pull request, with a weekly dependency
audit. `apps/web` has a `test` script and a vitest config; the repository is formatted.
Test count went from 314 across 6 workspaces to 333 across 7.

---

## R34 — RESOLVED — One unrecognised error string froze the curve stream for seven hours

**Observed 2026-09-17.** The curve stream's checkpoint had not moved since 00:37. Its
recorded error was:

```
[RPC_ERROR] eth_getLogs via https://rpc.ordofi.network:
  all RPC upstreams refused the request — fetch failed
```

Note the single endpoint. dRPC was never tried — and dRPC answered the identical
100-block query in 293 ms when probed directly.

**Root cause, and it is a taxonomy problem rather than a capacity one.** OrdoFi is
itself a proxy, so that message reports _its_ upstreams as unavailable. It matched none
of the classification patterns, so it fell through to `RPC_ERROR` — and `RPC_ERROR` was
non-retryable, on the reasoning that "a revert or a bad parameter will fail identically
everywhere". That reasoning is right for reverts. It is wrong for the _fallback bucket_,
because a bucket meaning "we do not recognise this" must not also assert "every endpoint
would answer the same way". Across heterogeneous third-party providers that assertion is
usually false, and when it is wrong the pool abandons healthy endpoints.

**Fix, at the level of the class rather than the instance.** The default is inverted:
`RPC_ERROR` is now retryable, and a new `DETERMINISTIC_ERROR` carries the positively
identified cases — `execution reverted`, `invalid params`, `method not found` — that
genuinely will not change with the endpoint. Being wrong in the retryable direction
costs one extra request; being wrong the other way cost seven hours. The OrdoFi string
is also matched explicitly as `UPSTREAM_UNAVAILABLE`.

**Effect:** curve stream 0 → ~3-4 blocks/second, health `degraded` → `ok`.

---

## R35 — RESOLVED — The log-window sizer relearned the same limit forever

dRPC's free plan rejects `eth_getLogs` ranges over **100 blocks**, while the rejection
message says _"ranges over 10000 blocks are not supported on free plan"_. The true limit
was established by binary search, not by reading the message.

The sizer used additive-increase / multiplicative-decrease with no memory, so against a
hard limit it cycled forever: 100 succeeds, grow to 126, rejected, halve to 63, climb
79, 99, 124, rejected. Measured in the running indexer, roughly **one tick in four**
scanned nothing, and the average window sat near 85 instead of 100. On a stream that
cannot keep pace with the chain, a quarter of every tick is not a rounding error.

**Fix.** The sizer now holds the largest span known to succeed and the smallest known to
fail, and steps to the midpoint — a binary search that converges and then stops. A
rejection no longer discards proven capacity: with 100 known good, a rejection at 126
steps to 113, not down to 63.

Measured after the change, from a cold start: the search went 126 → 113 → 106 → 103 →
102 per stream, five rejections, then **zero narrowings in the next 40 ticks**. A rare
re-probe keeps it from becoming a one-way ratchet, since a provider limit is a plan
setting rather than a law.

---

## R36 — RESOLVED (partially) — The factory never yielded RPC budget under pressure

The two streams share one pool of free endpoints, and the factory was meant to back off
when it had runway to spare so the curve stream could use the budget. The condition was
`factoryAtHead && slack > 50_000`, where `factoryAtHead` meant the last tick reached the
confirmed head _exactly_.

Under RPC pressure that is almost never true — a tick that fails, narrows, or lands a
few hundred blocks short reports false. Measured 2026-09-17: the factory sat 831 blocks
behind (~84 seconds) while the curve stream was 899,726 blocks behind (~25 hours), and
because 831 > 0 the factory never yielded anything.

**Fix.** The test is absolute rather than exact: the factory backs off when it is within
2,000 blocks (~3.4 minutes) of the head. That threshold is also the delay before a new
launch appears on the site, which is why it is tight rather than generous. A factory
genuinely falling behind still cancels its own backoff, which is the property the
previous fix existed to preserve.

**Partially resolved, and the remainder is not a code problem.** With both streams
running, the factory needs ~9.9 blocks/second simply to keep pace with the chain, and
the two free endpoints deliver roughly 12.8 blocks/second in total. The curve stream
therefore gets about 3 blocks/second and, being ~900,000 blocks behind, will not catch
up. No scheduling change fixes that arithmetic. See **R3**: the backfill needs HyperSync
or a paid endpoint.

---

## R37 — RESOLVED — The server-side topic filter was never sent

The curve stream filters on seven Pons event signatures across every curve on the
chain. It appeared to do so at the node. It did not.

`RpcLogSource` called viem's `getLogs` with a raw `topics` array. viem derives that
parameter from its own `event`/`events` options and ignores a raw one — captured
directly off the transport, the request carried:

```json
{ "topics": [], "fromBlock": "0x3e31949", "toBlock": "0x3e31999" }
```

An empty `topics` means "no filter". The node returned **every log on the chain** in
the range and a client-side `.filter()` discarded the rest.

**Measured 2026-09-17, over 100 blocks:** 4,097 logs returned, 63 of them Pons curve
events. **98.5% of the payload was downloaded and thrown away**, on the single resource
that constrains this indexer. The same query as raw JSON-RPC to the same endpoint
returned 17 logs for one topic — the node had been filtering correctly all along. It
was never asked to.

**Why it was invisible.** The indexer stayed _correct_ the whole time, because the
client-side filter did the work. Only throughput suffered, and throughput was already
known to be bad for other reasons, so it had a ready explanation. The unit tests passed
because they asserted the arguments handed to `getLogs`, not what left the process.

**Fix.** `eth_getLogs` goes through `RpcPool.request` with parameters built explicitly,
including the nested `topics: [[...]]` form that means "topic0 is any of these". The
tests now assert the JSON-RPC parameters themselves. The client-side filter is kept as
defence in depth against an endpoint that ignores `topics`.

---

## R38 — RESOLVED — A batch no single endpoint could take was abandoned entirely

`RpcPool.requestBatch` sent a batch only to endpoints whose known `maxBatchSize` was at
least the batch size. If none qualified, or if the qualifying ones failed, it raised
`BatchNotSupportedError` — and the caller's only answer was one request per item.

The two endpoints have very different limits: dRPC's free plan takes 3 calls per POST,
OrdoFi takes far more but was refusing everything. So a 23-call block-timestamp batch
had exactly one capable endpoint, that endpoint was the failing one, and dRPC — which
could have served the work as eight small POSTs — was never asked.

**Measured 2026-09-17:** nine of ten curve windows logged _"block timestamp batching
unavailable, falling back to single reads"_, roughly 25 sequential POSTs per window.
That dominated the tick and consumed the very budget the batching exists to save.

**Fix.** The pool splits into chunks the pool can actually serve, sequentially so a
free endpoint is not burst. Two conditions, and both are needed: skip the full-size
attempt when every endpoint has a known limit below it, and after a full-size attempt
fails, fall back to the largest limit any endpoint has declared. The first alone was
not enough — with dRPC's limit known and OrdoFi's unknown, nothing is proven about the
pool, so the full batch is attempted, only OrdoFi qualifies, and it is the one failing.

**Effect, combined with R34, R35 and R37:**

|                     | curve stream                            |
| ------------------- | --------------------------------------- |
| frozen (R34)        | 0 blocks/second                         |
| after R34           | ~4.0 blocks/second                      |
| after R35, R37, R38 | **~7.9 blocks/second**                  |
| timestamp fallbacks | 9 of 10 windows → **0 of 39**           |
| window narrowings   | ~1 tick in 4 → 10 at startup, then none |

The chain produces ~9.87 blocks/second, so the stream is close to keeping pace but
still does not catch up on a ~900,000 block backlog. See **R3**: that remains a
capacity problem, not a code one.

---

## R39 — C — The index is missing ~38M blocks of launch history, and reported `ok`

**Observed 2026-09-17.**

|                          |                                           |
| ------------------------ | ----------------------------------------- |
| `INDEXER_START_BLOCK`    | 26,841,846 (the factory deploy block)     |
| factory checkpoint       | 65,231,377                                |
| earliest indexed launch  | 63,775,021                                |
| `TokenLaunched` on-chain | present down to at least block 40,000,000 |
| tokens in the database   | 23,179                                    |

So roughly **38 million blocks** of launch history are absent from the index, and the
health endpoint reported `ok` throughout.

**How it hid.** The symptom was in the logs the whole time: about a quarter of decoded
curve logs resolved to no known token and were counted as `unmatched`. The code comment
next to that counter explained it as _"the factory stream may be behind"_ — and the
explanation was not checked. The curve stream is capped AT the factory checkpoint, so
the factory is always equal or ahead; on the day it was 900,000 blocks ahead. Sampling
the skipped curves settled it: every one was a genuine Pons V2 launch, confirmed
through `curve.token()` and the factory's own `getLaunchedToken().exists`.

**Mechanism.** `CheckpointRepository.getOrCreate` writes `INDEXER_START_BLOCK` only when
the checkpoint row is absent:

```ts
upsert({ create: { lastProcessedBlock: startBlock }, update: {} });
```

Once the row exists the configured value is ignored forever, and `advance` refuses to
move backwards. A checkpoint created once at the wrong height is therefore permanent,
and the environment variable that is supposed to control it silently stops meaning
anything. Whether this range was never scanned or was scanned and later lost cannot be
told apart after the fact — and it does not change the remedy.

**What was fixed: visibility, not the data.**

- A loud startup warning when the factory checkpoint sits above the configured start,
  naming both numbers and the size of the gap.
- `unscannedBelow` per stream, and `hasUnscannedHistory`, on the health endpoint.
- `status` is now `degraded` while a gap exists. An incomplete index is not healthy
  however current its head is — the same failure as R28, where freshness was reported
  from the fastest stream: technically about something real, and materially misleading.
- The curve stream is excluded from the flag, because it is fast-forwarded past
  provably empty history on purpose. It still reports its own `unscannedBelow`.

**What was NOT fixed, and why.** The history itself. Covering it means deliberately
rolling the factory checkpoint back and re-scanning ~38M blocks, which at RPC rates is
measured in days and needs `BACKFILL_SOURCE=hypersync`. That is an operator's decision
with a real cost, not something a process should do to itself at startup.

**Until it is covered**, treat every aggregate the product displays — token counts,
creator counts, total volume, trending — as covering roughly the last 1.5M blocks only.

---

## R40 — H — Every price quoted in the 8-decimal asset was stored as zero

**Measured 2026-09-17 against the indexed database:**

| quote decimals | tokens  | price = 0 |          |
| -------------- | ------- | --------- | -------- |
| 18             | 21,214  | 78        | 0.4%     |
| 6              | 2,022   | 21        | 1.0%     |
| **8**          | **124** | **124**   | **100%** |

Every token quoted in the 8-decimal asset had a price of zero — including SATOSHI,
after **395 settled trades**. Market cap follows price, so those tokens also carried a
market cap of zero, sorted to the bottom of Explore, and displayed `0` on their own
page.

**Cause.** `PRICE_SCALE` was 1e18, and that scale is sized for the QUOTE asset, not the
token. Fewer decimals in the quote leg means a numerically smaller `quoteAmount`
against the same 1e18-scaled `tokenAmount`, and the integer quotient floors. SATOSHI's
most recent sell moved 2,823 quote base units for 540,440,857,263,784,622,848,790 token
base units:

```
2823 * 1e18 / 5.4044e23 = 0.0052   -> 0
2823 * 1e27 / 5.4044e23 = 5223890  -> a real price
```

**Why nothing caught it.** This is not a float bug, so the lint rule that bans
`Number()` and `parseFloat()` could not see it — it is integer truncation at a scale
chosen for one asset and applied to all of them. The unit tests all used ETH vectors.
The `inspect:indexed` integrity check _did_ report it, as `WARN every launch has an
opening price (223 without)`, and that warning had been read as tokens that simply had
not traded yet.

**Fix.** `PRICE_SCALE` is now 1e27, which leaves an order of magnitude of headroom
below the worst observed vector. `marketCapFromPrice` divides the same scale back out,
so **market cap and volume keep their units and no display call site changed**. Only
`price` itself gains resolution. `formatPrice` now takes the scale exponent rather than
assuming 18 — a display off by 1e9 is not a rounding difference.

**Migration required, and NOT performed.** `price` is a fixed-point integer whose scale
is not stored beside it, so rows written under the old scale are not comparable with
new ones. Two different problems live in those rows, and the counts are worth keeping
apart (measured 2026-09-17, 439,520 trades):

|                                          | trades    |                                             |
| ---------------------------------------- | --------- | ------------------------------------------- |
| price 0 although both legs were non-zero | **2,144** | 0.5% — the old scale destroyed these        |
| price > 0                                | 437,376   | the same real price at a coarser resolution |

Only the first group lost information. The second is recoverable by arithmetic alone —
but it still has to be restated, because a column holding both scales at once sorts and
compares nonsense.

`scripts/recompute-prices.ts` restates them from `quoteAmount` and `tokenAmount`, which
are untouched chain data:

```bash
pnpm recompute:prices -- --dry-run
pnpm recompute:prices -- --apply
```

Stop the indexer first — it writes the same rows. Measured against the live database,
the dry run examines about 20,000 trades in 29 seconds, and slows when it competes with
the indexer for connections. Until it is run, prices are a mix of two scales.

**Still open — cross-asset comparability.** `marketCap` and `volume` are denominated in
each token's own quote asset, and Explore sorts and sums them together. A cap in
8-decimal units and one in ETH base units are not comparable, and `totalVolume` adds
them. The truncation is fixed; this is a separate product question about what a
cross-asset market cap should mean, and it is not answered here.

---

## R41 — M — "Trending" ranked by a column nothing writes

`packages/database/src/trending.ts` implements the PRD's trending score — 30% volume
acceleration, 25% unique traders, 20% trade activity, 15% buy pressure, 10% market-cap
growth, normalised against the cohort, capped against wash trading, integers
throughout. It is 206 lines, it is covered by tests, and it is exported from the
package.

**It has no caller.** `scoreTrending` is never invoked by any write path, so
`Token.trendingScore` holds its default of `0` for all 23,179 rows.

`ExploreRepository.orderFor` sorts `TRENDING` by `[{ trendingScore: desc }, { id: desc }]`.
With every score equal, that degenerates to `id desc` — cuid order, which is arbitrary
to a reader. The Trending tab was therefore showing an arbitrary list as a ranking, and
a list of tokens looks identical either way.

**Why it is not simply wired up.** Two reasons, and the second is the binding one:

1. The score is _cohort-relative_ — every component is normalised against the set being
   ranked — so it cannot be computed incrementally by the curve processor, which only
   sees the tokens touched in one window. It needs a periodic pass over the whole
   cohort.
2. It needs the curve stream near the head. The score's primary input is volume in a
   recent window against the window before it, and the curve stream is ~27 hours
   behind. A 24-hour window computed over trades that end a day ago would rank nothing
   meaningful — it would look computed, which is worse than looking empty.

So the ranking is not fabricated in the meantime. `anyTrendingScore` asks whether any
token carries a score, and the Explore page says plainly that the list is not a ranking
when none does, in the same idiom as the holder table and the freshness banner.

**To finish it:** cover the history (R39), let the curve stream reach the head (R3),
then add a periodic job calling `scoreTrending` over the active cohort. Its inputs are
all derivable from `trades` — recent and prior window volume, distinct traders, trade
count, buy and sell volume — except `priorMarketCap`, which wants the `VolumeSnapshot`
table that exists in the schema and is not yet written.

---

## R42 — H — The free database tier holds about 19 hours of this chain

Measured 2026-09-17, against the live database:

|                    |                                       |
| ------------------ | ------------------------------------- |
| trades stored      | 441,390                               |
| time they span     | **15.6 hours**                        |
| rate               | 28,244 trades/hour                    |
| space              | ~27.3 MB per hour of trades           |
| Neon project limit | 512 MB                                |
| therefore          | **~19 hours of trade history, total** |

The whole database is under one day of chain activity. That reframes several things
that looked like separate problems:

- **A retention policy measured in days cannot work.** A 7-day window matches nothing,
  because no trade survives long enough to reach 7 days old. Only a window shorter than
  what fits — hours, not days — frees anything, and `prune:trades` now says so rather
  than reporting zero without explanation.
- **Trending needs two comparable windows.** At 19 hours of capacity that is at most
  two 8-hour windows, which is thin but workable; `score:trending --window 8` is the
  honest setting on this tier.
- **R39 is not reachable from here.** Covering the ~38M unindexed blocks would need
  roughly 25× the current data. That is tens of gigabytes, not a bigger free tier.
- **Retention and backfill are mutually exclusive.** Retention is measured against the
  wall clock, so recovered history arrives already expired and is deleted on the next
  run.

**What was done.** Three never-scanned indexes were dropped (45 MB, about 1.6 hours of
headroom — see the migration for the measurements). `prune:trades` deletes old trades
while exempting the top tokens by trending score, and keeps every token row, because
tokens are 27 MB against trades' 426 MB and are what every page and link depends on.

**The way out, now built.** Aggregates. An hour of one token's trading collapses from
hundreds of ~1 KB trade rows to two small ones, and `candles` and `volume_snapshots`
have been in the schema for this since it was written.

- `pnpm rollup:aggregates -- --apply` builds hourly candles (open/high/low/close plus
  volume — the reason a chart becomes possible) and hourly volume snapshots (volume,
  the buy/sell split and DISTINCT traders — the inputs `scoreTrending` needs and a
  candle cannot supply). Only complete hours are built; the newest hour is still
  filling and freezing it would contradict the trades still arriving.
- `pnpm prune:trades -- --hours 6 --apply` then deletes the raw trades those aggregates
  cover.

**The interlock that makes it safe.** `prune:trades` will not delete past the point the
rollup has reached, whatever the retention window says. A trade no candle covers is the
only copy of that history, and rebuilding it means re-reading the chain — days of RPC
for this range. With no candles at all it refuses outright and says to run the rollup
first.

**Order matters, because the database is nearly full.** Drop the unused indexes first
(45 MB), then roll up, then prune. The rollup needs room to write before the prune can
free any, and both are resumable: if the rollup runs out of space part way, prune what
it has covered and continue.

**Still true afterwards.** Aggregates slow the growth by a large factor; they do not
make it zero, and they do not reach R39. Covering the ~38M unindexed blocks is a
different order of magnitude again.

## R43 — Token images were never indexed, and the column looked like a decision

**Status: fixed.** `Token.imageUrl` existed from the first migration and was NULL on
all 24,762 rows. The card rendered a letter mark and a comment explained the fallback
as a deliberate refusal to load untrusted image URLs — which read as a policy but was
actually a description of an empty column. There was no image URL to refuse.

The cause: `logo`, `description` and five social links are ARGUMENTS to the launch
transaction. They are not written to contract storage, not emitted in `TokenLaunched`,
and not returned by `getLaunchedToken`. The indexer read the ERC-20's name, symbol,
decimals and supply, which is everything the chain exposes through a read — and none
of it is the image.

`Token.launchTxHash` was stored all along, so every image was one
`eth_getTransactionByHash` away.

**Why the fix does not decode by function signature.** Launching is permissionless and
anyone may wrap it. Across the 60 most recent launches there are SEVEN entry points:
the router this repo has an ABI for (60%), a second router whose ABI is not published
(30%), Multicall3, and three aggregators. `decodeFunctionData` recovers under half,
and would silently stop working for new tokens the day Pons ships another router.

`extractLaunchMetadata` instead scans the calldata for ABI-encoded strings and anchors
on the token's real `name` and `symbol` read from the ERC-20. Finding that pair
adjacent identifies the tuple exactly; `logo` follows. No anchor, no guess: 87.5% of
24,926 tokens recovered, across routers whose ABI is unknown.

## R44 — Public IPFS gateways cannot serve a launchpad's images

**Status: mitigated, and worth watching.** Most token logos are `ipfs://`. Measured
against a live token CID, three of six public gateways returned 429, one did not
respond at all, and the two that worked took 2.6 s and 4.5 s. A single hardcoded
gateway would have failed most images.

The image reference is therefore stored as written (`ipfs://<cid>`), never as a
gateway URL — otherwise a gateway outage becomes a migration over 26,000 rows. Gateway
choice and order live in `imageFetchCandidates` and the proxy tries them within one
deadline.

Two bugs were found only by measuring the real thing, and both had failed silently:

  - `redirect: "manual"` rejected 4everland, which answers 301 to its own subdomain
    gateway. Redirects are now followed by hand with every hop re-validated, which
    keeps the SSRF protection that `manual` was there for.
  - The per-attempt timeout was 4 s, just under Pinata's typical 4.5 s, so the most
    reliable gateway looked like the least reliable one.

The proxy reported only the LAST failure, so both of these appeared as `ipfs.io`
returning 429 — pointing at rate limiting when neither cause was rate limiting. It now
reports every gateway's own outcome in `X-Image-Miss`.

Before: 3 of 18 served. After: 17 of 19.

**Remaining exposure.** These are free public gateways with no SLA. Vercel's CDN caches
a hit for a week, so steady-state traffic is light, but a cold cache after a deploy
depends on hosts nobody here controls. A dedicated gateway with an API key is the
durable answer if images matter commercially.

## R45 — Token image bytes are capped by the platform, not by preference

**Status: accepted.** A Vercel serverless function cannot return a body larger than
4.5 MB, so the proxy caps at 4 MB and a larger image falls back to the letter mark.
This is not theoretical: one live token ships a 3.8 MB PNG and another a 2.8 MB one —
creators upload full-resolution artwork for a 37-pixel avatar. The earlier 3 MB cap,
chosen as "larger than any legitimate token logo", would have dropped both.

Resizing on the proxy would fix the waste as well as the cap. It is not done here
because it means a native image codec in a serverless function, and the cap is not
currently the binding constraint on how the grid looks.

## R46 — SVG token images are not rendered

**Status: deliberate.** The proxy serves images same-origin, which is what keeps the
CSP at `img-src 'self'` and keeps visitor IPs away from creator-chosen hosts. An SVG
is a document and can carry `<script>`, and same-origin is exactly where that script
would run. The allowlist is PNG, JPEG, GIF, WebP and AVIF. This costs a small number
of legitimate logos and removes stored XSS from the threat model.

## R47 — Nothing generated the Prisma client, so a schema change broke the Vercel build

**Status: fixed.** Adding `Token.metadataCheckedAt` failed the Vercel build with:

    error TS2353: 'metadataCheckedAt' does not exist in type 'TokenCreateManyInput'

The migration had already been applied to the database. What was stale was the
GENERATED CLIENT: `prisma generate` writes TypeScript types into `node_modules`, and
nothing in this repo ever ran it as part of a build. It worked locally and on the VPS
only because `pnpm prisma:generate` was typed by hand after each schema change, which
is a step that exists nowhere in the repo and therefore could not survive a machine
that nobody types on.

Vercel made it worse by restoring `node_modules` from its build cache, so the client
came back as whatever it was before the column existed.

The fix is a root `postinstall` running `prisma generate`. It is deliberately NOT in a
package's `build` script: those run under Turborepo, and a cache hit replays logs
without executing, so the one run that mattered could be skipped. `postinstall` runs
on every `pnpm install`, before Turbo starts, and it needs no database connection —
`generate` reads the schema and nothing else.

It also removes the manual step from the VPS deploy: `pnpm install` now regenerates
the client on its own.

**A second, quieter version of the same gap, also fixed.** `prisma/schema.prisma` sits
at the repo root, so it was not an input to `@stunks/database`'s Turbo task. A schema
change with no change to that package's own files would have produced a CACHE HIT —
Turbo replaying an old success while the real code no longer typechecked. The schema
is now a `globalDependency`, so changing it invalidates every task that could be
affected by it.

## R48 — Turbo reports environment variables it will not pass to builds

**Status: understood, no change.** The Vercel build warns that `DATABASE_URL`,
`DIRECT_URL`, `RPC_ENDPOINTS` and others are set on the project but absent from
`turbo.json`, and "WILL NOT be available to your application".

This is about BUILD time only, and no build step reads them: every package's `build`
is `tsc --noEmit`, and the web app's pages are `force-dynamic`, so nothing queries the
database while building. At run time Vercel injects the variables into the serverless
function directly, with Turbo nowhere in the path. `NEXT_PUBLIC_*` is handled by
Turbo's own framework inference, which is why `@stunks/web` is absent from the warning
and why the CSP built from `NEXT_PUBLIC_RPC_ENDPOINTS` in `next.config.mjs` is correct.

Declaring them anyway would put `DATABASE_URL` into the cache key of tasks that never
read it, so a pooled-host change would invalidate unrelated builds. The warning is
left in place rather than silenced by a change that would make caching worse.
