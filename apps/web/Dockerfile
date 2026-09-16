# Web container.
#
# Build from the REPOSITORY ROOT, not this directory. The app imports workspace
# packages from ../../packages and brand assets from ../../Asset, so a build context
# scoped to apps/web cannot see what it needs:
#
#   docker build -f apps/web/Dockerfile -t stunks-web .
#
# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, not read at
# run time. They are build args here for that reason — setting them only as runtime
# environment variables would ship a bundle that still points at the defaults. None of
# them is a secret: they are the chain id, the public RPC list, the factory address and
# the public site URL, all of which end up in the browser anyway.

FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# ── dependencies ────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/database/package.json packages/database/
COPY packages/pons/package.json packages/pons/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/web3/package.json packages/web3/
RUN pnpm install --frozen-lockfile --filter @stunks/web...

# ── build ───────────────────────────────────────────────────────────────────
FROM base AS builder

ARG NEXT_PUBLIC_CHAIN_ID=4663
ARG NEXT_PUBLIC_PONS_V2_FACTORY=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
ARG NEXT_PUBLIC_RPC_ENDPOINTS=https://robinhood.drpc.org,https://rpc.ordofi.network
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID \
    NEXT_PUBLIC_PONS_V2_FACTORY=$NEXT_PUBLIC_PONS_V2_FACTORY \
    NEXT_PUBLIC_RPC_ENDPOINTS=$NEXT_PUBLIC_RPC_ENDPOINTS \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages ./packages

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY apps/web ./apps/web
# next.config.mjs sets experimental.externalDir so these are imported as modules.
COPY Asset ./Asset

# The Prisma client is generated, not committed, and the server components query
# through it. A placeholder URL is enough: generating needs the schema, not a
# reachable database.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN pnpm prisma generate --schema prisma/schema.prisma
RUN pnpm --filter @stunks/web build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# The whole tree is copied rather than a standalone bundle. `next start` against the
# installed dependencies is the exact configuration verified on this project; the
# standalone output would produce a smaller image but was not testable here, and an
# untested deployment path is worse than a large one. Revisit with a build to confirm.
COPY --from=builder /app ./

RUN useradd --create-home --shell /bin/false web && chown -R web:web /app
USER web

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/web
CMD ["pnpm", "exec", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
