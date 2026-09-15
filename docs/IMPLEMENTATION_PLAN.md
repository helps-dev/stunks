# STUNKS.FUN — Implementation Plan

**Status:** Phase 0 complete. Phase 1 defined below, awaiting approval.

---

## Phase 0 — Audit (done)

Repository inspected (empty apart from the PRD), PRD read in full, Pons V2
source cloned and read, and every integration-critical fact verified against
Robinhood Chain mainnet. Results in `PONS_V2_INTEGRATION.md`.

Four PRD assumptions were disproved and are corrected in the docs:

1. `quoteBuy()` / `quoteSell()` do not exist on Pons V2.
2. The trade events are `CurveBuy` / `CurveSell`, not `Buy` / `Sell`.
3. Graduation is triggered token-side (`sellableTokens() == 0`), not by a
   quote-side threshold comparison.
4. A snipe tax of up to 99% exists on deployed curves and is absent from the
   published source entirely.

One additional finding shapes the whole indexer: the chain produces ~852,912
blocks/day and the V2 factory is 36.6M blocks behind head.

---

## Phase 1 — Foundation (proposed scope)

Goal: a typechecked, tested, lint-clean monorepo that can talk to Robinhood
Chain and read real Pons V2 state. **No trading, no launching, no fake data, no
UI beyond a proof-of-read page.**

### 1.1 Repository and tooling
- `git init`, `.gitignore`, `.env.example`, license, README
- pnpm workspace + Turborepo pipeline (`build`, `lint`, `typecheck`, `test`)
- TypeScript strict, ESLint, Prettier
- Two custom lint rules, because both guard invariants this audit showed matter:
  - no `Number(` / `parseFloat(` on money-typed values
  - no raw `0x…40-hex` address literals outside `packages/config`

### 1.2 `packages/config`
- Chain definition for 4663 (verified values only)
- RPC list from env with documented per-endpoint quirks
- Single configured Pons input: the V2 factory address
- Zod-validated env loading that fails fast and never falls back to defaults

### 1.3 `packages/web3`
- viem client factory
- RPC pool: health tracking, latency/error-rate stats, retry with backoff,
  failover, and treating non-JSON bodies as transport failures
- Separate strategies for frontend (latency-first) and indexer (correctness-first)
- `assertChainId` guard used by every write path

### 1.4 `packages/pons`
- Verified ABI fragments, including the five snipe-tax functions recovered from
  bytecode
- On-chain address resolution from the factory, cached per chain
- Reads: `launchConfigCount`, `getLaunchConfig`, `getLaunchedToken`,
  `getLaunchFeePolicy`, curve reserves and parameters, live fee policy
- Exact `bigint` quote math for buy and sell
- Simulation-based quote path via `eth_call`
- Venue resolver over all four `GraduationPhase` values, including `Swept` as an
  explicit no-venue state
- Graduation progress calculator
- Event decoders keyed by verified `topic0`

### 1.5 `packages/database` + Prisma schema
- Postgres schema for the models in the PRD, money columns as `NUMERIC(78,0)`
- `Trade` unique on `(chainId, transactionHash, logIndex)`
- `Token` unique on `(chainId, address)`
- `IndexerState` with `chainId`, `lastProcessedBlock`, `lastProcessedBlockHash`,
  `updatedAt`
- Columns separated by trust level: on-chain canonical vs indexed-derived vs
  moderation metadata
- Indexes designed for the actual Explore/leaderboard queries
- Migration committed; **no seed data**

### 1.6 `packages/types`, `packages/utils`
- Shared domain types, `GraduationPhase`, venue union
- bigint money helpers: parse, format, bps math, percentage, floor-division
  helpers matching contract semantics exactly

### 1.7 Tests
- Unit: quote math against the three verified vectors from the audit; graduation
  progress; `reservedTokens` derivation; fee split arithmetic; venue resolver
  across all four phases; bps helpers
- Integration (live read-only, network-gated): chain ID, factory reads, launch
  config dump, address resolution, curve state read, and
  **off-chain math vs `eth_call` equality** — the regression test that protects
  the core of the trading engine

### 1.8 `scripts/verify-pons.ts`
The audit probes, promoted to a committed script so the documented numbers are
re-checkable and drift is visible.

### 1.9 Proof-of-read page
One route rendering live launch config, live fee policy, and resolved addresses,
all labelled with their source. No token lists, no charts, no placeholder cards.

### Phase 1 exit criteria
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass
- Integration tests read real Robinhood Chain state
- Verified quote math reproduces on-chain results exactly in CI
- No fake tokens, trades, volume, holders, fees, or Pons behaviour anywhere
- Docs match the code

### Explicitly not in Phase 1
Launch transactions, trading, indexer, charts, explore, competition, admin.

---

## Phase 2 — Pons launch + Protected Launch (flagship feature)

Launch wizard; dynamic config from chain; `previewLaunchEconomics` pinning; salt
prediction; full transaction state machine (Idle → Quoting → Awaiting Wallet →
Pending → Confirmed / Failed / Rejected); receipt parsing; launch detection and
persistence.

Plus the STUNKS differentiator, specified in `WHITELIST_LAUNCH.md`: whitelist up
to 32 recipient addresses at launch, then fill all of them at the untaxed price
from inside STUNKS, with no bot and no key custody. This is viable because the
snipe-tax exemption was verified to key on `recipient` rather than `msg.sender`,
so one funded wallet can deliver to all 32.

Sub-phases:

- **2a** launch flow with whitelist declaration, sequential bundle buy (Option A,
  no new contract)
- **2b** `StunksBundleBuy` stateless bundler contract (Option B) — one transaction,
  all recipients at the same price. Requires design review and audit before
  mainnet. This is what makes the feature actually beat a bot, because the
  measured tax decays from ~99% to 0.19% within two seconds.

Acceptance test: a small-value mainnet launch with a real whitelist, measuring
achieved age and tax per recipient.

## Phase 3 — Indexer
**Gate:** settle the backfill data source first (paid archive RPC vs Envio
HyperSync). Then: block scanner, decoder, processor, checkpointing with block
hashes, reorg handling with confirmation depth, RPC failover, dynamic per-curve
subscription for `CurveBuy`/`CurveSell`, graduation indexing, holder accounting
(mint/burn/zero-address aware), health metrics.

## Phase 4 — Token page
Token page, OHLC candles from indexed trades, trade history, graduation progress,
holders, token info, phase-aware states including `Swept`.

## Phase 5 — Trading
Curve buy/sell with simulation-backed quotes, slippage and price impact, partial
fill handling, snipe-window handling. Uniswap V4 trading **only after** the V4
quoting path is verified.

## Phase 6 — Explore
Search, filters, sorting, trending engine with configurable weights, graduating
and graduated views, cursor pagination, Redis caching.

## Phase 7 — Creator
Creator profile and dashboard from indexed data. Creator earnings only once the
fee escrow surface is verified.

## Phase 8 — Competition
Volume leaderboards from indexed trades, configurable competition rules,
anti-abuse (self-trade exclusion, minimum sizes, per-wallet caps, exclusion
lists, wash-trade heuristics), competition stats.

## Phase 9 — Rewards
Only after economics are verified. Off-chain leaderboard first; on-chain
distribution and any `StunksCompetition.sol` / `StunksRewards.sol` only if
genuinely required.

## Phase 10 — Production hardening
Security review, RPC failover drills, indexer recovery drills, monitoring,
rate limiting, load testing, E2E, deployment, backups, incident runbook.

---

## Sequencing note

The PRD recommends indexer before launch. This plan keeps launch (Phase 2) ahead
of the indexer because the indexer's backfill strategy is still an open
infrastructure decision, while launch depends only on facts already verified.
Both orderings converge at Phase 4. Say the word if you prefer the PRD's order
and I will swap them.
