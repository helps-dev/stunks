# Indexer container.
#
# Deploying this near the database matters less than it did before batched writes took
# throughput from ~2-7 to ~100 blocks/second, but it still helps: every remaining round
# trip costs less when the latency is single-digit milliseconds.
#
# Build from the REPOSITORY ROOT, not this directory — the indexer depends on workspace
# packages that live above it:
#
#   docker build -f apps/indexer/Dockerfile -t stunks-indexer .

FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# ── dependencies ────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/indexer/package.json apps/indexer/
COPY packages/config/package.json packages/config/
COPY packages/database/package.json packages/database/
COPY packages/pons/package.json packages/pons/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/web3/package.json packages/web3/
COPY apps/web/package.json apps/web/
# A full workspace install, not `--filter @stunks/indexer...`.
#
# The filtered form looked leaner and was broken: it selects the seven workspace
# packages and NOT the workspace root, so the root devDependency `prisma` never lands
# in node_modules and the `pnpm prisma generate` below fails with a missing command.
# Verified by listing what the filter actually selects. The filter also has to be fed
# every package.json it might select, so it was not saving much anyway. This costs image
# size — Next.js comes along for the ride — and buys a build that works.
RUN pnpm install --frozen-lockfile

# ── runtime ─────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/indexer/node_modules ./apps/indexer/node_modules
COPY --from=deps /app/packages ./packages

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY apps/indexer ./apps/indexer

# Generate the Prisma client for this platform. DATABASE_URL is not needed to generate,
# only to connect, so a placeholder keeps the build hermetic.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN pnpm prisma generate --schema prisma/schema.prisma

# Non-root. The indexer only ever reads the chain and writes the database; it holds no
# keys and signs nothing, so it needs no privileges beyond that.
RUN useradd --create-home --shell /bin/false indexer && chown -R indexer:indexer /app
USER indexer

EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9464/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/indexer
CMD ["pnpm", "start"]
