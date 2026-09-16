# Deploying STUNKS.FUN to a VPS

Two containers, one hosted Postgres. The web app serves the site, the indexer writes
the chain into the database, and nothing else is stateful.

## Pick the region first

This is not a formality. It is the decision that most affects whether the indexer keeps
up with the chain at all.

Measured from a laptop in Asia against the Neon database in `us-east-2`:

|                                        |                           |
| -------------------------------------- | ------------------------- |
| One `SELECT 1` round trip              | 306 ms (min 279, max 349) |
| One curve tick, end to end             | 12.20 s                   |
| ...of which the checkpoint write alone | 1.57 s                    |
| Resulting curve throughput             | 5.7 blocks/s              |
| Chain production                       | 9.87 blocks/s             |

A tick spends most of its time waiting, and every wait is a round trip to a database on
another continent. Below chain production the backlog grows and never clears, whatever
else is tuned.

Find your database region in the connection host. Neon encodes it directly:
`ep-...-pooler.c-7.us-east-2.aws.neon.tech` is `us-east-2`, so put the VPS in Ohio, or
in `us-east-1` next door. In-region the same round trip is single-digit milliseconds.

If the VPS is already somewhere else and cannot move, the alternative is to move the
database instead — Neon can branch into another region — or to accept the backlog and
use HyperSync for the catch-up. What does not work is a distant VPS with a distant
database.

## Requirements

- 2 vCPU, 4 GB RAM, 20 GB disk. The web image builds Next.js, which is the memory peak;
  the running containers are far lighter. 2 GB works for running but is tight to build.
- Docker with the Compose plugin.
- Ports 80 and 443 open if the site is to be public.

## Steps

```bash
git clone <your remote> stunks && cd stunks
cp .env.example .env
```

Fill in `.env`. The values that must be real are `DATABASE_URL` and `DIRECT_URL`; the
chain, factory and RPC defaults in `.env.example` are the verified mainnet ones and can
stay as they are. Add `DOMAIN` and `ACME_EMAIL` if the site gets a domain.

Apply the schema. Safe to run against a database that already has it — it applies only
what is missing:

```bash
pnpm install --frozen-lockfile
pnpm prisma:deploy
```

Set the real domain for the browser bundle. `NEXT_PUBLIC_*` is compiled in at build
time, so editing `.env` afterwards will not change it — edit the `args` block under
`web` in `docker-compose.yml`:

```yaml
NEXT_PUBLIC_APP_URL: "https://your-domain"
```

Then bring it up:

```bash
docker compose up -d --build                     # web on 127.0.0.1:3000
docker compose --profile public up -d --build    # ...plus HTTPS on 80/443
```

## Verify

```bash
docker compose ps                        # both services healthy
curl -s http://127.0.0.1:9464/health     # over SSH; not exposed publicly
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/launch
```

In the health output, `streams[].lagBlocks` is the number to watch. Falling means the
indexer is catching up; rising means it is losing to chain production, and the region is
the first thing to check.

## What is deliberately not exposed

The indexer health endpoint has no authentication. It reports checkpoints, RPC endpoint
URLs and failure counts, so both Compose and the Caddyfile keep it on localhost. Read it
over SSH. Do not add it to the reverse proxy without putting auth in front of it.

The web app itself is intentionally public and unauthenticated: it is a non-custodial
dApp, users sign with their own wallets, and there is no session to protect. It holds no
keys and never asks for a private key or seed phrase.

## Faster catch-up

With a large backlog, set a free token from https://app.envio.dev/api-tokens and switch
the source, then restart the indexer:

```
HYPERSYNC_BEARER_TOKEN=...
BACKFILL_SOURCE=hypersync
```

Over the free RPC endpoints the sustainable `eth_getLogs` window is about 100 blocks,
which is what caps the indexer. HyperSync serves millions of blocks per query.

## Notes

- The web image copies the installed tree and runs `next start`. That is the exact
  configuration verified on this project. `output: "standalone"` would produce a much
  smaller image and is worth revisiting, but it has not been build-tested here.
- Only ever run one indexer replica. Two on the same streams race on checkpoints. The
  writes are idempotent so nothing corrupts, but they duplicate every RPC call.
- `apps/indexer/fly.toml` covers the Fly.io path instead, with the same region rule.
