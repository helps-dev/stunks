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

## R21 — C — Indexer throughput is below the chain's block rate

Measured by running the real indexer against mainnet, not estimated:

```text
chain produces          ~10 blocks/second
indexer sustained        2–7 blocks/second
```

So the indexer currently falls further behind over time. It indexed 716 tokens and
392 creators correctly, with all integrity checks passing, but it cannot keep pace.

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

**Remaining remedies, in order of expected effect:**

- **Co-locate the database with the indexer.** Neon is in `us-east-2`; the measurement
  was taken from a developer machine on another continent. Removing ~300 ms per round
  trip is plausibly a 10–50x improvement and costs nothing but a deployment choice.
- **Batch the launch writes.** Collect a window's launches and insert them with one
  `createMany` plus one batched creator upsert, instead of a transaction per launch.
- **Use HyperSync for backfill** (already implemented and pluggable).

**Do not treat the indexer as production-ready until it demonstrably sustains more
than 10 blocks/second in its deployment environment.** Until then it is correct but
not able to stay current.

---

## R22 — H — The curve stream scans from the factory deploy block

The curve stream starts at the same block as the factory stream and scans forward
looking for `CurveBuy` / `CurveSell` from the curves it knows about. Since curves only
exist from their own launch block onward, every block before the earliest known launch
is guaranteed to contain nothing for it.

Observed: the curve stream scanning from block 26,842,730 at ~233 blocks/second with
zero matching logs, which would take ~44 hours to reach the head.

**Mitigation, not yet implemented:** start the curve stream at the minimum
`launchBlock` of the tokens it tracks, and ideally track a per-curve start block so a
newly discovered curve does not force a rescan of history that cannot concern it.

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
paid archive RPC with wide `getLogs` (Alchemy, Chainstack, dwellir all advertise
4663) or Envio HyperSync, which documents Robinhood Chain support.

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

| # | Question | Blocks | Verify by |
| --- | --- | --- | --- |
| U8 | Real bundle latency for STUNKS' own path: launch receipt → buy inclusion | whether Protected Launch delivers its advantage | small-value mainnet test launch with a real whitelist |
| U13 | Whether a co-located indexer sustains >10 blocks/second | whether the indexer can stay current at all (R21) | deploy the indexer in the database's region and re-measure |
| U10 | Where the collected snipe tax goes (protocol / creator / buyback / reserve) | fee analytics and honest mechanism copy | verified source, or trace a taxed buy's value flow |
| U12 | Exact composition of deductions once they exceed 100% (age 0 of a launch) | nothing — quotes there come from simulation | verified source, or a controlled fresh launch |

**Resolved since first draft**

| # | Was | Resolution |
| --- | --- | --- |
| U1 | Exact snipe-tax decay function | `startBps >> floor(elapsed*14/seconds)`, matching independent measurements; and `currentSnipeTaxBps(address)` exists on-chain, so it is read rather than computed |
| U3 | Envio HyperSync coverage for 4663 | **Supported.** `/height` returns a value tracking the chain head (measured lag ~113 blocks). Queries need a free token from app.envio.dev. Implemented as a pluggable source; `pnpm probe:sources` re-checks it |
| U9 | Approved pair-token list | `pairTokenEconomics(address)` and `approvedPairTokens(address)` verified present; five pairs re-read and matched exactly. USDG is 6 decimals |
| U11 | The router's declarable-exemption limit | **31, verified first-hand.** `pnpm probe:exemptions` simulates `launchAndBuy` at 0/1/30/31/32/33 declared addresses: 31 succeeds, 32 reverts. Encoded as `MAX_DECLARABLE_SNIPE_EXEMPTIONS` with tests |
| — | "Launch and buy cannot be atomic" | **Wrong.** `PonsV2LaunchAndBuy.launchAndBuy` (`0xf85f8e41`) is public and in active use; the creator's own buy is atomic and unfront-runnable |

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
