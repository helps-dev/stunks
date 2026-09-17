-- Drop three indexes that pg_stat_user_indexes reported as never scanned.
--
-- Measured on the production database, 2026-09-17, against 23,680 tokens and 434,523
-- trades: each had idx_scan = 0 while together occupying 45 MB of a 512 MB project.
--
--   trades (traderAddress, timestamp)  41 MB  nothing queries trades by wallet; the
--                                             app has no portfolio or wallet history
--   tokens (chainId, phase, marketCap)  2 MB  Explore orders by marketCap and by
--   tokens (chainId, phase, volume24h)  2 MB  volume24h WITHOUT a phase predicate, so
--                                             a (chainId, phase, ...) index cannot be
--                                             used for either ordering
--
-- Reversible: recreate the first alongside a wallet history page, and the other two
-- only if the queries gain a phase filter.

DROP INDEX IF EXISTS "trades_traderAddress_timestamp_idx";
DROP INDEX IF EXISTS "tokens_chainId_phase_marketCap_idx";
DROP INDEX IF EXISTS "tokens_chainId_phase_volume24h_idx";
