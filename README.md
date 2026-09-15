# STUNKS.FUN

A non-custodial token launchpad and trading interface on **Robinhood Chain**
(chain ID `4663`), built on **Pons V2** as its launch and bonding-curve
infrastructure, with **Uniswap V4** as the venue for graduated tokens.

STUNKS is the product layer. Pons V2 is the protocol layer. STUNKS deploys no
launch, curve, or liquidity contracts of its own.

**Status: Phase 1 (foundation) complete.** There is no trading, no launching, and
no indexed data yet. The one page that exists reads live Pons state and labels
every value with where it came from.

---

## Why this repository looks careful

A Phase 0 audit verified every integration-critical fact directly against mainnet
rather than trusting documentation. Four assumptions from the original PRD turned
out to be **wrong**, and one upstream inconsistency shapes the whole design:

| Assumption | Reality |
| --- | --- |
| Pons exposes `quoteBuy()` / `quoteSell()` | **They do not exist.** Confirmed absent from deployed bytecode. STUNKS computes quotes itself and confirms by simulation. |
| Trade events are `Buy` / `Sell` | They are `CurveBuy` / `CurveSell`, emitted per-launch by each curve. |
| Graduation triggers on a quote-side threshold | The trigger is token-side: `sellableTokens() == 0`. |
| Anti-snipe behaviour is documented | An anti-snipe tax of up to **99%** exists on deployed curves and appears **nowhere** in Pons's published source. |

And the finding that drives everything else:

> **Pons's published GitHub source does not match its deployment.**
> `PonsV2LaunchFactory.sol` calls `exemptFromSnipeTax` on the curve, while
> `PonsV2BondingCurve.sol` in the same commit does not define it — that source set
> cannot compile. `snipeTaxSeconds` also reads `3` on-chain versus `15` in source.

So this codebase treats **the chain as the only source of truth**. ABIs were
assembled from selectors confirmed in deployed bytecode, and `pnpm verify:pons`
re-checks the documented facts on demand.

Full detail: [`docs/PONS_V2_INTEGRATION.md`](docs/PONS_V2_INTEGRATION.md).

---

## Quick start

Requires Node ≥ 20 and pnpm 9. Verified on Node 26.7.0 / pnpm 9.12.0.

```bash
pnpm install
cp .env.example .env          # fill in DATABASE_URL when you have one
pnpm prisma:generate

pnpm typecheck                # all 7 workspaces
pnpm lint
pnpm test                     # 128 tests, hermetic (no network)
pnpm build

pnpm verify:pons              # 35 live checks against mainnet
pnpm --filter @stunks/web dev # proof-of-read page on :3000
```

Live read-only integration tests are opt-in so `pnpm test` never depends on the
network:

```bash
RUN_LIVE_TESTS=1 pnpm test:integration
```

---

## Layout

```text
apps/
  web/               Next.js 15 — Phase 1 proof-of-read page only
packages/
  config/            chain 4663, env validation, THE only hardcoded addresses
  types/             domain types (GraduationPhase, TradingVenue, quotes)
  utils/             bigint money helpers with contract-exact rounding
  web3/              RPC pool: failover, health, non-JSON detection
  pons/              the Pons V2 integration boundary
  database/          Prisma client + the bigint <-> Decimal crossing
prisma/schema.prisma
scripts/verify-pons.ts
docs/
```

Planned but not yet built: `apps/api` (Fastify), `apps/indexer`, `packages/ui`.

---

## Four invariants, enforced by tooling

**1. Money is an integer, end to end.** Every amount, price, reserve and fee is a
`bigint` at base-unit precision, stored as `NUMERIC(78, 0)`. This is not
stylistic: the verified quote math reproduces on-chain results *exactly to the
wei*, and one float conversion destroys that. A lint rule bans
`Number()`/`parseFloat()`/`parseInt()`, and exemptions require a written reason.

**2. Addresses live in exactly one place.** Only the Pons factory address is
configured; the other eleven addresses are resolved by calling the factory,
because the protocol owner can rotate several of them. A lint rule bans address
literals outside `@stunks/config`.

**3. Quotes are never invented.** Local math is used only when it is provably
valid. Inside the anti-snipe window the combined deductions exceed 100% and Pons's
reconciliation of that is measured but unexplained, so `computeCurveBuy` throws
`SnipeTaxNotModellableError` and the quote comes from `eth_call` simulation
instead. A failed quote surfaces as an error, never a placeholder number.

**4. No fake data, anywhere.** No fake tokens, trades, volume, holders, market
caps or fees — not even as UI placeholders. If the chain is unreachable, the page
says so.

---

## Two things worth knowing up front

**STUNKS earns nothing from Pons trading fees.** The live fee policy splits
protocol 30% / buyback 50% / creator 20%, and no parameter routes value to a
third-party interface. `platformRevenue()` returns `0n` and that is a *verified
answer*, not a placeholder. Any revenue model needs a separate mechanism.

**`Swept` is a tradeable-looking state with no venue.** A token can sit with its
curve drained and its Uniswap V4 pool not yet created, because Pons deliberately
swallows a failed auto-graduation rather than reverting the buy that triggered it.
A venue resolver that only asks "graduated or not" will route users into
transactions that always revert. `resolveTradingVenue` handles all four phases and
is covered by exhaustive tests.

---

## Verification

`pnpm verify:pons` checks the chain, the resolved address graph, factory
parameters, launch configs, the fee policy, deployed bytecode selectors (including
that the quote functions are still absent), approved pair-token economics, and
that local quote math still equals `eth_call` at current reserves.

Immutable facts that change are reported as **FAIL**. Owner-mutable parameters
that change are reported as **INFO**, because that is drift to document, not a bug.

Current: **35 checks, 0 failed.**

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | layering, chain config, quoting strategy, indexing scale |
| [`docs/PONS_V2_INTEGRATION.md`](docs/PONS_V2_INTEGRATION.md) | verified addresses, ABIs, events, exact math |
| [`docs/WHITELIST_LAUNCH.md`](docs/WHITELIST_LAUNCH.md) | the Protected Launch differentiator |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | phases 1–10 and Phase 1 scope |
| [`docs/KNOWN_RISKS.md`](docs/KNOWN_RISKS.md) | risks and open unknowns |

---

## Security

Non-custodial by construction. STUNKS never holds a private key, a seed phrase, or
user funds, and never signs on a user's behalf — including in the indexer. Chain ID
is asserted before any write path, and a token address from a URL is confirmed
against the factory's `getLaunchedToken().exists` before any trading surface
renders, so STUNKS cannot become a trading UI for an arbitrary contract.

## License

Not yet determined.
