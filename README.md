# STUNKS.FUN

A non-custodial token launchpad and trading interface on **Robinhood Chain**
(chain ID `4663`), built on **Pons V2** as its launch and bonding-curve
infrastructure, with **Uniswap V4** as the venue for graduated tokens.

STUNKS is the product layer. Pons V2 is the protocol layer. STUNKS deploys no
launch, curve, or liquidity contracts of its own.

**Status: phases 1–6 built.** Launching (including the Protected Launch bundle),
curve trading, the indexer, the token page and explore all exist and run against
mainnet. Graduated tokens are deliberately not tradeable here yet — see R26.

As of 2026-09-17 the indexed database holds 20,258 tokens, 370,312 trades and
15,612 creators. That number is not a boast: the curve stream was 715,288 blocks
behind the head at the time, which is roughly twenty hours. Indexer throughput on
free public RPC is the open operational problem, not a solved one — see
[Operating the indexer](#operating-the-indexer).

---

## Why this repository looks careful

A Phase 0 audit verified every integration-critical fact directly against mainnet
rather than trusting documentation. Four assumptions from the original PRD turned
out to be **wrong**, and one upstream inconsistency shapes the whole design:

| Assumption                                    | Reality                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Pons exposes `quoteBuy()` / `quoteSell()`     | **They do not exist.** Confirmed absent from deployed bytecode. STUNKS computes quotes itself and confirms by simulation. |
| Trade events are `Buy` / `Sell`               | They are `CurveBuy` / `CurveSell`, emitted per-launch by each curve.                                                      |
| Graduation triggers on a quote-side threshold | The trigger is token-side: `sellableTokens() == 0`.                                                                       |
| Anti-snipe behaviour is documented            | An anti-snipe tax of up to **99%** exists on deployed curves and appears **nowhere** in Pons's published source.          |

And the finding that drives everything else:

> **Pons's published GitHub source does not match its deployment.** > `PonsV2LaunchFactory.sol` calls `exemptFromSnipeTax` on the curve, while
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

pnpm typecheck                # all 8 workspaces
pnpm lint
pnpm test                     # 333 tests, hermetic (no network)
pnpm build

pnpm verify:pons              # live checks against mainnet
pnpm --filter @stunks/web dev # the app on :3000
pnpm --filter @stunks/indexer dev
```

CI runs typecheck, lint, tests, formatting, the Prisma schema check and the build
on every push and pull request, plus a weekly `pnpm audit --prod` so an advisory
published after a green merge still surfaces.

Live read-only integration tests are opt-in so `pnpm test` never depends on the
network:

```bash
RUN_LIVE_TESTS=1 pnpm test:integration
```

---

## Layout

```text
apps/
  web/               Next.js 15 — landing, explore, token page, launch, trading
  indexer/           two-stream log indexer (factory + curves) with reorg handling
packages/
  config/            chain 4663, env validation, THE only hardcoded addresses
  types/             domain types (GraduationPhase, TradingVenue, quotes)
  utils/             bigint money helpers with contract-exact rounding
  web3/              RPC pool: failover, health, non-JSON detection
  pons/              the Pons V2 integration boundary
  database/          Prisma client + the bigint <-> Decimal crossing
prisma/schema.prisma
scripts/verify-pons.ts
deploy/              Caddyfile, systemd units, Caddy image with rate limiting
docs/
```

The web app reads Postgres directly from server components. A separate
`apps/api` becomes worthwhile when something other than this app consumes the
data; until then it would only add a serialisation hop. `packages/ui` likewise
does not exist, because there is one consumer of the components.

Nine of the fifteen tables in `prisma/schema.prisma` are not yet written by
anything — `token_transfers`, `pools`, `volume_snapshots`, `candles`,
`fee_events`, the three competition tables and `admin_audit_log`. The schema was
designed for the whole product; the indexer has reached tokens and trades. Two
consequences are visible in the UI today: there are no candles, so no chart, and
no transfer stream, so holder counts read "not indexed yet" rather than a number.

---

## Four invariants, enforced by tooling

**1. Money is an integer, end to end.** Every amount, price, reserve and fee is a
`bigint` at base-unit precision, stored as `NUMERIC(78, 0)`. This is not
stylistic: the verified quote math reproduces on-chain results _exactly to the
wei_, and one float conversion destroys that. A lint rule bans
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
third-party interface. `platformRevenue()` returns `0n` and that is a _verified
answer_, not a placeholder. Any revenue model needs a separate mechanism.

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

Three outcomes, and the third one matters:

| Outcome  | Meaning                                                         | Exit |
| -------- | --------------------------------------------------------------- | ---- |
| **FAIL** | a documented immutable fact is no longer true — stop-work       | 1    |
| **INFO** | an owner-mutable parameter moved — drift to document, not a bug | 0    |
| **????** | the endpoint could not answer — says nothing either way         | 2    |

The third exists because the script used to abort the whole run on the first RPC
error. When dRPC stopped serving archive state at the factory's deploy block, all
eight sections stopped running — including the thirty-odd checks that only need
current state — and nobody would have noticed a real drift behind that.

Current, against a pruning public endpoint: **34 checks, 0 failed, 1 unverifiable.**
The unverifiable one is the deploy-block existence check, which needs archive
state. Run it against an archive endpoint for a fully clean result:

```bash
RPC_ENDPOINTS=<archive-capable endpoint> pnpm verify:pons
```

---

## Operating the indexer

Two streams run concurrently. The factory stream follows one address and keeps up
with the head easily. The curve stream filters on event signature across every
curve on the chain, and it is capped at the factory checkpoint so a trade always
has a token to attach to.

The curve stream is the one that falls behind, and how far behind it is determines
how old every price, volume and market cap on the site is.

```bash
curl http://127.0.0.1:9464/health
```

That endpoint is unauthenticated and reports checkpoints, RPC URLs and failure
counts, so it binds to loopback. `HEALTH_HOST` is what enforces that — a port
number never restricted a binding — and it is overridden to `0.0.0.0` only inside
the container, where the `127.0.0.1:9464:9464` mapping does the same job.

**If the curve stream is falling behind**, the constraint is the free public RPC
endpoints, which both streams share. Measured on 2026-09-17, with both streams
running: the factory needs ~9.9 blocks/second simply to keep pace with the chain,
and the two free endpoints deliver roughly 12.8 blocks/second between them. The
curve stream gets what is left, which is about 3 blocks/second — so a backlog of
900,000 blocks does not shrink. That arithmetic is not something scheduling can
fix.

Before reaching for capacity, check the two failure modes that look identical to
being slow but are not:

- **A stream frozen at one block** while the other advances. The checkpoint does
  not move at all and `lastSuccessAt` is hours old. This was R34: one endpoint's
  error string was classified as non-retryable, so the pool gave up without trying
  the other. Fixed, and the taxonomy now fails in the retryable direction.
- **`log range narrowed, retrying` on a large share of ticks.** Each one scanned
  nothing. This was R35: the sizer kept rediscovering a limit that had not moved.
  Fixed; after a cold start expect about five narrowings per stream and then none.

If neither applies, it is genuinely capacity. In order of effect:

1. **Use HyperSync for the backfill.** `BACKFILL_SOURCE=hypersync` with a free
   token from [app.envio.dev](https://app.envio.dev/api-tokens). RPC backfill of
   36.8M blocks was measured at roughly 51 hours; HyperSync answers millions of
   blocks per query.
2. **Add a paid RPC endpoint** to `RPC_ENDPOINTS`. Two free endpoints is not
   enough for a chain producing ~9.9 blocks per second.
3. **Put the VPS in the same region as the database.** From a laptop in Asia to
   Neon in us-east-2, one round trip is 306 ms, and a curve tick spent about 1.6 s
   of its 12.2 s purely on the checkpoint write.

Until the curve stream is current, the UI says so: the freshness banner reports
the **slowest** stream, not the fastest, and names which one it is.

### Moderation

`ExploreRepository` hides `HIDDEN` and `FLAGGED` tokens from every listing. The
lever for setting them is a script, deliberately paired with an audit row:

```bash
pnpm moderate -- --list HIDDEN
pnpm moderate -- --token 0x… --status HIDDEN --actor 0x… --reason "impersonates USDC"
```

Anyone can deploy a token called `USDC` on an open launchpad, and STUNKS renders
whatever name the chain reports. This changes only whether STUNKS lists a token —
never the token, the curve, or anyone's balance. The status change and its audit
row are written in one transaction, because a moderation action without a record
of who took it is the state this is meant to prevent.

---

## Documentation

| Document                                                     | Contents                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)               | layering, chain config, quoting strategy, indexing scale |
| [`docs/PONS_V2_INTEGRATION.md`](docs/PONS_V2_INTEGRATION.md) | verified addresses, ABIs, events, exact math             |
| [`docs/WHITELIST_LAUNCH.md`](docs/WHITELIST_LAUNCH.md)       | the Protected Launch differentiator                      |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | phases 1–10 and Phase 1 scope                            |
| [`docs/KNOWN_RISKS.md`](docs/KNOWN_RISKS.md)                 | risks and open unknowns                                  |
| [`docs/DEPLOY_VPS.md`](docs/DEPLOY_VPS.md)                   | single-VPS deployment, Docker and systemd                |

---

## Security

Non-custodial by construction. STUNKS never holds a private key, a seed phrase, or
user funds, and never signs on a user's behalf — including in the indexer. Chain ID
is asserted before any write path, and a token address from a URL is confirmed
against the factory's `getLaunchedToken().exists` before any trading surface
renders, so STUNKS cannot become a trading UI for an arbitrary contract.

## License

Not yet determined.
