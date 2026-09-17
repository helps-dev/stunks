# Deploying STUNKS.FUN

Three shapes, and they are not interchangeable:

- **Path A — systemd**, both halves on one VPS. Recommended for a single box.
- **Path B — Docker Compose**, both halves on one VPS behind Caddy.
- **Path C — indexer on a VPS, web app on Vercel.** Different enough to have its own
  section: nothing in `deploy/Caddyfile` is in the request path.

Two processes, one hosted Postgres. The web app serves the site, the indexer writes the
chain into the database, and nothing else holds state.

Two paths are documented. The systemd path uses only commands verified on this project
and is the recommended one. The Docker path is provided but has never been build-tested,
because the development machine has no Docker.

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

Find the database region in the connection host. Neon encodes it directly:
`ep-...-pooler.c-7.us-east-2.aws.neon.tech` is `us-east-2`, so put the VPS in Ohio or in
`us-east-1` next door. In-region that same round trip is single-digit milliseconds.

What does not work is a distant VPS with a distant database.

### Moving the database to the server instead

Often the better direction. A VPS in Singapore is also far closer to this project's likely
users than Ohio is, so moving the database gives both a fast indexer and a fast site.

Neon offers `aws-ap-southeast-1` (Singapore), but a project's region is fixed when it is
created — branching does not help, since every branch shares the project region. Moving
means creating a new project in the target region and copying into it. See
[Neon: regions](https://neon.com/docs/conceptual-guides/regions) and
[Neon: changing region](https://neon.com/faqs/change-region-existing-neon-project).

The copy is small. Measured on this database: 314 MB total, 320,834 trades (278 MB),
19,275 tokens, 14,350 creators.

```bash
# 1. Create a new Neon project in the target region, then from any machine:
pg_dump "$OLD_DATABASE_URL" -Fc -f stunks.dump
pg_restore -d "$NEW_DIRECT_URL" --no-owner --no-acl stunks.dump

# 2. Point .env at the new project, then confirm the indexer agrees with the data
pnpm verify:db
pnpm inspect:indexed
```

Stop the indexer before dumping, or it will keep writing to the old database and those
trades will be missing from the copy. The checkpoint travels with the data, so the indexer
resumes exactly where it stopped rather than rescanning.

Content was rephrased for compliance with licensing restrictions.

## Requirements

- Ubuntu 22.04 or 24.04. 2 vCPU, 4 GB RAM, 20 GB disk.
- 4 GB matters for the Next.js build, not for running. On 2 GB, add swap before building.
- Ports 80 and 443 open only if the site gets a public domain.

## Path A — systemd (recommended)

### 1. Use the image's default user

Ubuntu cloud images already ship a non-root user with sudo — `ubuntu` on Tencent
Lighthouse, AWS and most others. Use it. The unit files in `deploy/` assume
`ubuntu` and `/home/ubuntu/stunks`.

```bash
whoami        # expect ubuntu, not root
sudo -v       # confirms sudo works
```

Creating a dedicated service account adds nothing here: the default user is already
unprivileged, and the services drop further privileges themselves through
`ProtectSystem`, `ProtectHome` and `NoNewPrivileges`. If your image logs you in as root
instead, then create a user — and update `User`, `Group` and the paths in both unit
files to match.

Note that a browser console (Tencent OrcaTerm, AWS EC2 Connect) already puts you inside
the VPS. There is no `ssh` step to run from there.

### 2. Node 22 and pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo corepack enable
corepack prepare pnpm@9.12.0 --activate
node -v && pnpm -v      # expect v22.x and 9.12.0
```

### 3. Clone and configure

```bash
cd ~ && git clone https://github.com/helps-dev/stunks.git && cd stunks
cp .env.example .env
nano .env
```

Only `DATABASE_URL` and `DIRECT_URL` must be filled in with real values. The chain,
factory address and RPC defaults in `.env.example` are the verified mainnet ones and can
stay as they are. Set `NEXT_PUBLIC_APP_URL` to the public URL if there is a domain.

Then lock the file down, since it holds the database password:

```bash
chmod 600 .env
```

### 4. Install, migrate, build

```bash
pnpm install --frozen-lockfile
pnpm prisma:deploy        # safe on a database that already has the schema
pnpm --filter @stunks/web build
```

The build is the memory-hungry step. If it is killed on a small VPS, add swap:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 5. Start both services

```bash
sudo cp deploy/stunks-indexer.service deploy/stunks-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now stunks-indexer stunks-web
```

Both units assume `/home/stunks/stunks`. Edit the paths inside them if the clone lives
elsewhere.

### 6. Verify

```bash
systemctl status stunks-indexer stunks-web --no-pager
curl -s http://127.0.0.1:9464/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/launch    # expect 200
journalctl -u stunks-indexer -f
```

In the health output, `streams[].lagBlocks` is the number to watch. Falling means it is
catching up; rising means it is losing to chain production, and the region is the first
thing to check.

### Updating later

```bash
cd ~/stunks && git pull
pnpm install --frozen-lockfile
pnpm prisma:deploy
pnpm --filter @stunks/web build
sudo systemctl restart stunks-indexer stunks-web
```

`next start` serves an existing build, so skipping the build step after a pull silently
keeps serving the old site.

## Path B — Docker Compose

Not build-tested. One bug was already found by inspection and fixed: both Dockerfiles ran
a filtered `pnpm install` that excludes the workspace root, so the root devDependency
`prisma` was absent and `pnpm prisma generate` would have failed on a missing command.
They now do a full workspace install.

```bash
cp .env.example .env && nano .env && chmod 600 .env
# NEXT_PUBLIC_* is compiled into the browser bundle at build time, so edit the
# `args:` block under `web` in docker-compose.yml, not .env, for the real domain.
docker compose up -d --build                     # web on 127.0.0.1:3000
docker compose --profile public up -d --build    # ...plus HTTPS on 80/443
```

The schema still has to be applied once, from the host or any machine with the repo:
`pnpm prisma:deploy`.

## Path C — indexer on a VPS, web app on Vercel

This splits the two halves across providers, and it is a different shape from Paths A
and B rather than a variation of them. The things to get right are the ones that stop
being true when Caddy is no longer in the request path.

### The web app on Vercel

**Root directory.** The app imports the brand assets from the monorepo root
(`../../../../Asset/banner-stunks.png`) and depends on six workspace packages that ship
TypeScript source rather than a build artefact. A project whose Root Directory is
`apps/web` uploads only that folder and the build fails on the first import. Either:

- set Root Directory to the repository root and Build Command to
  `pnpm --filter @stunks/web build`, or
- keep `apps/web` and enable **Include source files outside of the Root Directory in
  the Build Step**.

`prisma generate` already runs as part of `@stunks/web`'s build script, so the client is
generated during the build rather than expected in the repository.

**Environment variables.** The `NEXT_PUBLIC_*` values are compiled into the browser
bundle, so they are needed at BUILD time and changing one requires a redeploy — setting
it in the dashboard is not enough on its own:

| variable                      | when    | notes                              |
| ----------------------------- | ------- | ---------------------------------- |
| `NEXT_PUBLIC_CHAIN_ID`        | build   | `4663`                             |
| `NEXT_PUBLIC_PONS_V2_FACTORY` | build   | the verified factory address       |
| `NEXT_PUBLIC_RPC_ENDPOINTS`   | build   | also becomes the CSP `connect-src` |
| `NEXT_PUBLIC_APP_URL`         | build   | the real domain                    |
| `DATABASE_URL`                | runtime | the POOLED Neon host               |

`DIRECT_URL` is only used by `prisma migrate`, so Vercel does not need it. Run
migrations from the VPS or a laptop, not from a build.

**The CSP is built from `NEXT_PUBLIC_RPC_ENDPOINTS`.** `apps/web/next.config.mjs`
derives `connect-src` from the same variable the wallet client reads, so the two cannot
drift. The consequence is that adding an RPC endpoint needs a **redeploy**: an endpoint
the CSP does not name is blocked by the browser, and the only symptom is a console
message.

**Security headers travel with the app.** They used to live only in `deploy/Caddyfile`,
which is not in the request path here — this deployment would have shipped with no CSP,
no `X-Frame-Options` and no `Referrer-Policy`. They are now set in `next.config.mjs` and
apply wherever the app runs. The Caddyfile no longer repeats them, because a browser
intersects two CSP headers and that is a confusing way to find out one was wrong.

**What Vercel does not give you.** The rate limiting discussed under Path B lives in
Caddy and is not in this path. Every page is `force-dynamic`, so each request is a
function invocation that reaches Neon and, on the landing page, the chain. Use Vercel's
own firewall or accept that a refresh loop competes with the indexer for the same free
RPC budget.

**The protocol cache is per instance.** `apps/web/src/lib/read-chain.ts` holds the Pons
address graph and factory parameters for 60 seconds in module scope. On one long-lived
server that is one read per minute; on serverless each instance keeps its own copy and
cold starts miss, so expect a lower hit rate. It is still correct — the head block is
always read fresh and `protocolReadAt` reports the age — just less effective.

### The indexer on the VPS

Only the indexer runs there, so most of Path B does not apply. Follow Path A and skip
the `stunks-web` service, or with Docker start the one service:

```bash
docker compose up -d --build indexer
```

`HEALTH_HOST` stays `127.0.0.1`. Read it over SSH:

```bash
curl http://127.0.0.1:9464/health
```

Do not open 9464 to reach it from Vercel. It reports checkpoints, RPC URLs and failure
counts with no authentication in front of it, and nothing in the web app consumes it.

### What both halves share

The database, and the region decision at the top of this document still applies — but
it applies to the **VPS**, which does the heavy writing. Vercel's functions read; the
indexer writes continuously and a cross-region round trip costs it far more.

### Order of operations on the first deploy

`PRICE_SCALE` changed from 1e18 to 1e27 (R40). The recompute has to happen while
nothing is writing, so:

```bash
# on the VPS
sudo systemctl stop stunks-indexer
pnpm recompute:prices -- --dry-run
pnpm recompute:prices -- --apply
sudo systemctl start stunks-indexer
```

Deploying the web app before that is harmless — it only reads. Starting the NEW indexer
before that is not: it writes 1e27 prices into a table of 1e18 ones, and the two are
indistinguishable afterwards.

---

## HTTPS and a domain

Point an A record at the VPS, then either use the Caddy profile above, or with the
systemd path install Caddy directly:

```bash
sudo apt-get install -y caddy
sudo caddy reverse-proxy --from your-domain --to 127.0.0.1:3000
```

For something permanent, put `deploy/Caddyfile` at `/etc/caddy/Caddyfile`, set `DOMAIN`
and `ACME_EMAIL`, change `reverse_proxy web:3000` to `reverse_proxy 127.0.0.1:3000`, then
`sudo systemctl restart caddy`. Caddy obtains and renews the certificate itself.

## Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp     # only if the site is public
sudo ufw enable
```

Do not open 3000 or 9464. Both are meant to be reachable only from the VPS itself.

## What is deliberately not exposed

The indexer health endpoint has no authentication. It reports checkpoints, RPC endpoint
URLs and failure counts, so it stays on localhost in every path here. Read it over SSH.
Do not put it behind the public proxy without adding auth first.

The web app is intentionally public and unauthenticated: it is a non-custodial dApp, users
sign with their own wallets, and there is no session to protect. It holds no keys and
never asks for a private key or seed phrase.

## Faster catch-up

With a large backlog, get a free token from https://app.envio.dev/api-tokens, add it to
`.env`, and restart the indexer:

```
HYPERSYNC_BEARER_TOKEN=...
BACKFILL_SOURCE=hypersync
```

Over the free RPC endpoints the sustainable `eth_getLogs` window is about 100 blocks,
which is what caps the indexer. HyperSync serves millions of blocks per query.

## Notes

- Only ever run one indexer. Two on the same streams race on checkpoints. The writes are
  idempotent so nothing corrupts, but they duplicate every RPC call for no benefit.
- The web image copies the installed tree and runs `next start` rather than using
  `output: "standalone"`. Standalone would be much smaller and is worth revisiting once
  there is a machine that can build and test it.
- `apps/indexer/fly.toml` covers the Fly.io path instead, with the same region rule.
