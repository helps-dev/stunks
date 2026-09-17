# Caddy with the rate-limit module compiled in.
#
# The standard caddy image does not ship `rate_limit`, and Caddy refuses to start on
# an unknown directive — so the directive in the Caddyfile stays commented out until
# this image is the one running.
#
# To enable rate limiting:
#   1. build with this file (docker compose --profile public build caddy)
#   2. uncomment the rate_limit block in deploy/Caddyfile
#   3. docker compose --profile public up -d
#
# Why it is wanted: every page is force-dynamic, so each request reaches the database
# and, on the landing page, the chain. Those chain reads share the free public RPC
# endpoints the indexer depends on, and the indexer is already the constrained party.

FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
