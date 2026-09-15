# STUNKS.FUN — Architecture

**Status:** Phase 0 (audit complete, awaiting Phase 1 approval)
**Verified against:** Robinhood Chain mainnet, chain ID `4663`, block `63,444,974` (2026-09-15T06:23:29Z)

Every number and address in this document was read from the chain or from
verified deployed bytecode. Nothing here is copied from marketing material.
Where something could not be verified it is marked `UNKNOWN` and carries no
assumed value.

---

## 1. Layering

STUNKS.FUN is the product layer. Pons V2 is the protocol layer. STUNKS deploys
no launch, curve, or liquidity contracts of its own.

```text
┌──────────────────────────────────────────────────────────┐
│ apps/web        Next.js — launch, trade, explore, compete│
├──────────────────────────────────────────────────────────┤
│ apps/api        Fastify — read API over indexed state    │
├──────────────────────────────────────────────────────────┤
│ apps/indexer    block scanner → event decode → Postgres  │
└───────────────┬──────────────────────────────┬───────────┘
                │                              │
      ┌─────────▼──────────┐        ┌──────────▼──────────┐
      │ packages/pons      │        │ packages/database   │
      │ the ONLY module    │        │ Prisma, single      │
      │ that knows Pons    │        │ schema owner        │
      │ ABIs and addresses │        └─────────────────────┘
      └─────────┬──────────┘
                │
      ┌─────────▼──────────┐
      │ packages/web3      │  RPC pool, failover, retry
      └─────────┬──────────┘
                │
        Robinhood Chain (4663)
                │
      ┌─────────┴─────────────┐
      │                       │
  Pons V2 bonding curve   Uniswap V4 PoolManager
  (pre-graduation)        (post-graduation, via PonsV2MemeHook)
```

**Hard rule:** no file outside `packages/pons` may contain a Pons address, ABI
fragment, or fee constant. This is enforceable by lint rule and is the main
defence against the copy-paste address drift that this audit already found in
Pons's own published source (see `KNOWN_RISKS.md`, R1).

---

## 2. Repository layout

Greenfield. The workspace contained only `STUNKS_FUN_V1_PRD.md`, and is not yet
a git repository. Target:

```text
stunks/
├── apps/
│   ├── web/                 Next.js App Router
│   ├── api/                 Fastify + Zod
│   └── indexer/             block scanner + workers
├── packages/
│   ├── pons/                Pons V2 integration boundary
│   ├── web3/                viem clients, RPC failover
│   ├── database/            Prisma client + repositories
│   ├── types/               shared domain types
│   ├── config/              chain + address + env resolution
│   ├── ui/                  shadcn/ui components
│   └── utils/               bigint/Decimal money helpers
├── prisma/schema.prisma
├── scripts/                 verification + ops scripts
├── docs/
└── tests/
```

`pnpm` 9.12.0 and Node 26.7.0 are installed. Turborepo for task orchestration.
Docker and psql are **not** installed on this machine — local Postgres/Redis
provisioning is an open setup task (`KNOWN_RISKS.md`, R9).

---

## 3. Chain configuration

Verified by direct `eth_chainId` / `eth_getBlockByNumber` calls.

| Item | Value | How verified |
| --- | --- | --- |
| Chain ID | `4663` (`0x1237`) | `eth_chainId` |
| Native currency | ETH, 18 decimals | Arbitrum Orbit L2, ETH gas |
| Testnet chain ID | `46630` | Robinhood docs (not probed) |
| Measured block time | **0.1013 s** | timestamp delta over 10,000 blocks |
| Blocks per day | **~852,912** | derived from the above |
| Head at audit | `63,444,974` | `eth_blockNumber` |

### RPC endpoints

| Endpoint | Result | Notes |
| --- | --- | --- |
| `https://rpc.mainnet.chain.robinhood.com` | **unreachable from this network** | `robinhood.com` DNS is intercepted here and resolves to `internetpositif.id` (`36.86.63.185`), an ISP content filter. A local network problem, not a production one. |
| `https://rpc.ordofi.network` | **works**, 4663 | verified; used by third-party Pons tooling |
| `https://robinhood.drpc.org` | **works**, 4663, archive state at block 1 | `eth_getLogs` rejected above a small span; ~100-block windows succeed |
| `https://rpc.nodeflare.app/robinhood/public` | **works**, 4663 | Not listed on the public chains page but the route exists. Rate limited (~2 req/s); returns an HTML 403 page instead of JSON when throttled — the client must treat non-JSON as a transport failure, not a chain answer. |
| `https://robinhoodchain.blockscout.com` | Cloudflare 403 from this network | blocks explorer-API verification locally |
| `https://4663.rpc.thirdweb.com` | `Invalid chain` | not supported |

The RPC layer must therefore assume: heterogeneous log-range limits, aggressive
rate limits, and **non-JSON error bodies**. `packages/web3` wraps every endpoint
with health tracking, retry with backoff, and failover, and treats a non-JSON
200/403 body as a failed transport rather than a result.

---

## 4. Money representation

All financial values are `bigint` at wei/base-unit precision end to end:
on-chain read → indexer → Postgres (`NUMERIC(78,0)`) → API (decimal string) →
frontend (`bigint`). `Number` and `parseFloat` are banned for token amounts,
prices, market caps, volumes, reserves, and fees, enforced by lint rule.

Display formatting is the only place a value becomes lossy, and it happens at
render time, never before storage.

This is not stylistic. The verified quote math (§5) reproduces on-chain results
**exactly at wei precision**, and that property is lost the moment a value
passes through a float.

---

## 5. Quoting: the central architectural constraint

**The Pons V2 bonding curve exposes no quote function.** Verified by scanning
the deployed curve's runtime bytecode for function selectors:

```text
ABSENT:  quoteBuy(uint256)            0x4beb394c
ABSENT:  quoteSell(uint256)           0xa64190c4
ABSENT:  getAmountOut(uint256,bool)   0x11106ee2
```

The PRD (§26, §28, §29) assumes `quoteBuy()` / `quoteSell()` exist on Pons.
They do not. STUNKS must produce quotes itself.

Two mechanisms, both implemented, cross-checked against each other:

**A. Off-chain replication of the exact integer math** (fast path, used for
keystroke-latency quoting)

```text
fee  = quoteIn * feeBps        / 10000
tax  = quoteIn * creatorTaxBps / 10000
net  = quoteIn - fee - tax
out  = (net * tokenReserve) / (quoteReserve + net)        // floor division

where quoteReserve, tokenReserve come from curve.getReserves()
      feeBps, creatorTaxBps are per-curve immutables
```

Verified: this reproduced the on-chain result **exactly**, to the wei, at
0.01 / 0.1 / 1 ETH against live curve `0xe0d8…d87A`:

```text
buy 0.01 ETH → 5,740,664,023,199,384,506,125,347 tokens   exact match
buy 0.1  ETH → 54,586,381,541,924,592,009,003,939 tokens  exact match
buy 1    ETH → 366,037,735,849,056,603,773,584,905 tokens exact match
```

**B. `eth_call` simulation of `buy` / `sell`** (authoritative path)

Simulation is the source of truth and is required — not optional — whenever the
fast path cannot be trusted:

- the curve is inside its snipe-tax window (`block.timestamp - launchedAt <
  snipeTaxSeconds`), where an undocumented decaying tax of up to **99%** applies
- the trade is large enough to be partially filled against `reservedTokens`
- the token has graduated (Uniswap V4 path)

The exact snipe-tax decay curve is `UNKNOWN` (see `PONS_V2_INTEGRATION.md` §8
and `KNOWN_RISKS.md`, R2). Because it is unknown, STUNKS never computes it —
it simulates instead. A launch younger than its snipe window is quoted by
simulation only.

---

## 6. Trading venue resolution

Venue is derived from on-chain `GraduationPhase`, read live, never from the
database. The enum is verified from source and its meaning from the factory's
graduation flow:

```text
NotGraduated → Pons V2 bonding curve (curve.buy / curve.sell)
Swept        → NO VENUE. Curve drained, V4 pool not yet created.
                Trading must be disabled and the UI must say so.
PoolCreated  → Uniswap V4 pool, governed by PonsV2MemeHook
Rescued      → terminal, no venue. Reserves released manually.
```

`Swept` is a real, reachable, tradeable-looking-but-untradeable state, because
the curve's `_tryAutoGraduate()` deliberately swallows a failed graduation
(emitting `AutoGraduationFailed`) so a failure cannot take the threshold-crossing
buy down with it. A venue resolver that only distinguishes "graduated or not"
will offer trades that always revert. This is the single most likely correctness
bug in the trading layer.

---

## 7. Graduation progress

Verified exactly on-chain — the reserve allocation is not an approximation:

```text
reservedTokens = supply * phantomQuote / (phantomQuote + graduationThreshold)

computed  285,714,285,714,285,714,285,714,285
on-chain  285,714,285,714,285,714,285,714,285   match
```

Because `phantomQuote * supply` is held constant, the quote-side threshold and
the token-side allocation are the *same point*. Progress may be displayed as
`realQuoteReserve / graduationThreshold`, which is what the PRD specifies.

But the actual **trigger** is token-side: `readyToGraduate()` is
`sellableTokens() == 0`. The quote side is a floor a large trade can overshoot;
the token side is a hard stop the curve refuses to cross. STUNKS therefore
displays the quote-side percentage and gates behaviour on the token-side
condition.

---

## 8. Indexing strategy

The scale is the design driver:

```text
V2 factory deployed at block   26,841,846  (2026-08-03T14:41:19Z)
head                           63,444,974
backfill                       36,600,844 blocks
at ~100–500 block getLogs windows on a free RPC, paced to ~2 req/s
                              → 10+ hours of pure RPC for ONE address filter
```

Per-curve `CurveBuy`/`CurveSell` filters multiply this. Naive block scanning
against public RPC is not viable for backfill.

Consequences, to be settled at the start of Phase 3:

- **Backfill** needs either a paid archive RPC with wide `eth_getLogs` support
  (Alchemy / Chainstack / dwellir all advertise 4663) or Envio HyperSync, which
  documents Robinhood Chain support. Not yet probed — `UNKNOWN`.
- **Live tailing** at ~10 blocks/sec is comfortable on a single healthy RPC.
- Trades are indexed from the **curve** contracts pre-graduation and from the
  **Uniswap V4 PoolManager singleton**, filtered by `poolId`, post-graduation.
  These are two different sources for the same token's volume, which is why
  `VolumeSnapshot` must record which venue produced each figure.

Idempotency key is `(chainId, transactionHash, logIndex)`, unique-constrained,
so a restart or replay cannot double-count.

---

## 9. What STUNKS earns

Verified from the live fee policy on `PonsV2MemeHook`:

```text
protocolFeeShareBps       3000   → Pons protocol
buybackBurnBps            5000   → buyback-and-lock earmark
hookFeeBps                 100   → hook cut on graduated-pool swaps
protocolFeeRecipient      0x263ed295dAFaE1d9AAdD6E56c4B6F9f38eE019Dd
feeEscrow                 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e
```

**No parameter in Pons V2 routes any value to STUNKS.** Routing an interface's
trades through Pons earns the interface nothing. STUNKS V1 therefore reports
platform revenue as **zero**, and the `FeeAdapter` interface exists only as a
read-only analytics seam. No `StunksFeeAdapter` is deployed, and none should be
until a real routing mechanism is verified to exist.

---

## 10. Security posture

- Non-custodial by construction. No private keys, no seed phrases, no signing on
  behalf of users, anywhere in the stack, including the indexer.
- Chain ID is asserted before every write path. A wallet on the wrong chain is
  blocked in the UI, not just warned.
- The token address in a route is untrusted input: checksum-validated, then
  confirmed against the factory's `getLaunchedToken(...).exists` before the app
  will render a trading panel. This prevents STUNKS from becoming a trading UI
  for an arbitrary contract that merely looks like a Pons launch.
- Slippage minimums are always sent on-chain (`minTokensOut` / `minQuoteOut`).
  A quote is advisory; the on-chain bound is the actual protection.
- Admin surface is authenticated, authorised, and audit-logged, and can only
  touch STUNKS moderation metadata. It cannot alter Pons state or user funds.
- Public endpoints are rate-limited and every input is Zod-validated at the
  boundary.

---

## 11. Related documents

- `PONS_V2_INTEGRATION.md` — verified addresses, ABIs, events, math
- `IMPLEMENTATION_PLAN.md` — phases and Phase 1 scope
- `KNOWN_RISKS.md` — risks and open unknowns
