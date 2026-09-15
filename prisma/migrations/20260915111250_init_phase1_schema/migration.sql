-- CreateEnum
CREATE TYPE "GraduationPhase" AS ENUM ('NOT_GRADUATED', 'SWEPT', 'POOL_CREATED', 'RESCUED');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TradeVenue" AS ENUM ('CURVE', 'UNISWAP_V4');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('NORMAL', 'FEATURED', 'VERIFIED', 'HIDDEN', 'FLAGGED');

-- CreateTable
CREATE TABLE "tokens" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 18,
    "imageUrl" TEXT,
    "description" TEXT,
    "websiteUrl" TEXT,
    "twitterUrl" TEXT,
    "telegramUrl" TEXT,
    "discordUrl" TEXT,
    "farcasterUrl" TEXT,
    "creatorAddress" TEXT NOT NULL,
    "deployerAddress" TEXT NOT NULL,
    "curveAddress" TEXT NOT NULL,
    "pairTokenAddress" TEXT NOT NULL,
    "pairTokenDecimals" INTEGER NOT NULL DEFAULT 18,
    "launchConfigId" BIGINT NOT NULL,
    "totalSupply" DECIMAL(78,0) NOT NULL,
    "creatorTaxBps" INTEGER NOT NULL,
    "buybackEnabled" BOOLEAN NOT NULL,
    "graduationThreshold" DECIMAL(78,0) NOT NULL,
    "poolFee" INTEGER NOT NULL,
    "tickSpacing" INTEGER NOT NULL,
    "phantomQuote" DECIMAL(78,0) NOT NULL,
    "reservedTokens" DECIMAL(78,0) NOT NULL,
    "snipeTaxStartBps" INTEGER,
    "snipeTaxSeconds" INTEGER,
    "launchedAt" TIMESTAMP(3),
    "phase" "GraduationPhase" NOT NULL DEFAULT 'NOT_GRADUATED',
    "realQuoteReserve" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "graduationBps" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "marketCap" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "volume24h" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "volumeTotal" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "holderCount" INTEGER NOT NULL DEFAULT 0,
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "buyCount" INTEGER NOT NULL DEFAULT 0,
    "sellCount" INTEGER NOT NULL DEFAULT 0,
    "trendingScore" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "moderationStatus" "ModerationStatus" NOT NULL DEFAULT 'NORMAL',
    "moderationNote" TEXT,
    "hadWhitelistBundle" BOOLEAN NOT NULL DEFAULT false,
    "whitelistSize" INTEGER NOT NULL DEFAULT 0,
    "launchBlock" BIGINT NOT NULL,
    "launchTxHash" TEXT NOT NULL,
    "firstTradeAt" TIMESTAMP(3),
    "lastTradeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "creatorId" TEXT NOT NULL,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "curveAddress" TEXT,
    "venue" "TradeVenue" NOT NULL DEFAULT 'CURVE',
    "traderAddress" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "tokenAmount" DECIMAL(78,0) NOT NULL,
    "quoteAmount" DECIMAL(78,0) NOT NULL,
    "feeAmount" DECIMAL(78,0) NOT NULL,
    "creatorTaxAmount" DECIMAL(78,0) NOT NULL,
    "snipeTaxAmount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "refundAmount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "price" DECIMAL(78,0) NOT NULL,
    "marketCap" DECIMAL(78,0) NOT NULL,
    "excludedFromCompetition" BOOLEAN NOT NULL DEFAULT false,
    "exclusionReason" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holders" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "balance" DECIMAL(78,0) NOT NULL,
    "isProtocolAccount" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_transfers" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "isMint" BOOLEAN NOT NULL DEFAULT false,
    "isBurn" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creators" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "graduatedCount" INTEGER NOT NULL DEFAULT 0,
    "totalVolume" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "totalFeesIndexed" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pools" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "currency0" TEXT NOT NULL,
    "currency1" TEXT NOT NULL,
    "hookAddress" TEXT NOT NULL,
    "poolFee" INTEGER NOT NULL,
    "tickSpacing" INTEGER NOT NULL,
    "positionId" DECIMAL(78,0),
    "lockedTokens" DECIMAL(78,0),
    "seededQuote" DECIMAL(78,0),
    "graduatedAt" TIMESTAMP(3) NOT NULL,
    "graduationTxHash" TEXT NOT NULL,

    CONSTRAINT "pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volume_snapshots" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "venue" "TradeVenue" NOT NULL,
    "volume" DECIMAL(78,0) NOT NULL,
    "buyVolume" DECIMAL(78,0) NOT NULL,
    "sellVolume" DECIMAL(78,0) NOT NULL,
    "tradeCount" INTEGER NOT NULL,
    "uniqueTraders" INTEGER NOT NULL,
    "openPrice" DECIMAL(78,0) NOT NULL,
    "closePrice" DECIMAL(78,0) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "volume_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candles" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "interval" INTEGER NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(78,0) NOT NULL,
    "high" DECIMAL(78,0) NOT NULL,
    "low" DECIMAL(78,0) NOT NULL,
    "close" DECIMAL(78,0) NOT NULL,
    "volume" DECIMAL(78,0) NOT NULL,
    "tradeCount" INTEGER NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_events" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "protocolAmount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "creatorAmount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "buybackAmount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "platformAmount" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_state" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "lastProcessedBlock" BIGINT NOT NULL,
    "lastProcessedBlockHash" TEXT,
    "confirmationDepth" INTEGER NOT NULL DEFAULT 12,
    "logWindowSize" INTEGER NOT NULL DEFAULT 100,
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "failed_blocks" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT NOT NULL,
    "firstFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFailedAt" TIMESTAMP(3) NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "failed_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitions" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "minTradeSize" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "minTradeCount" INTEGER NOT NULL DEFAULT 1,
    "maxWalletContribution" DECIMAL(78,0),
    "excludedAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeBundleWallets" BOOLEAN NOT NULL DEFAULT true,
    "prizePoolDescription" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_participants" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "qualifyingVolume" DECIMAL(78,0) NOT NULL,
    "rawVolume" DECIMAL(78,0) NOT NULL,
    "tradeCount" INTEGER NOT NULL,
    "excludedVolume" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competition_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_rewards" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "assetAddress" TEXT NOT NULL,
    "claimTxHash" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "actorAddress" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tokens_chainId_phase_volume24h_idx" ON "tokens"("chainId", "phase", "volume24h" DESC);

-- CreateIndex
CREATE INDEX "tokens_chainId_phase_marketCap_idx" ON "tokens"("chainId", "phase", "marketCap" DESC);

-- CreateIndex
CREATE INDEX "tokens_chainId_createdAt_idx" ON "tokens"("chainId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "tokens_chainId_trendingScore_idx" ON "tokens"("chainId", "trendingScore" DESC);

-- CreateIndex
CREATE INDEX "tokens_chainId_phase_graduationBps_idx" ON "tokens"("chainId", "phase", "graduationBps" DESC);

-- CreateIndex
CREATE INDEX "tokens_creatorId_idx" ON "tokens"("creatorId");

-- CreateIndex
CREATE INDEX "tokens_moderationStatus_idx" ON "tokens"("moderationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_chainId_address_key" ON "tokens"("chainId", "address");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_chainId_curveAddress_key" ON "tokens"("chainId", "curveAddress");

-- CreateIndex
CREATE INDEX "trades_tokenId_timestamp_idx" ON "trades"("tokenId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "trades_traderAddress_timestamp_idx" ON "trades"("traderAddress", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "trades_tokenId_side_timestamp_idx" ON "trades"("tokenId", "side", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "trades_chainId_blockNumber_idx" ON "trades"("chainId", "blockNumber");

-- CreateIndex
CREATE INDEX "trades_timestamp_idx" ON "trades"("timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "trades_chainId_transactionHash_logIndex_key" ON "trades"("chainId", "transactionHash", "logIndex");

-- CreateIndex
CREATE INDEX "holders_tokenId_balance_idx" ON "holders"("tokenId", "balance" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "holders_tokenId_walletAddress_key" ON "holders"("tokenId", "walletAddress");

-- CreateIndex
CREATE INDEX "token_transfers_tokenId_timestamp_idx" ON "token_transfers"("tokenId", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "token_transfers_chainId_transactionHash_logIndex_key" ON "token_transfers"("chainId", "transactionHash", "logIndex");

-- CreateIndex
CREATE INDEX "creators_chainId_totalVolume_idx" ON "creators"("chainId", "totalVolume" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "creators_chainId_address_key" ON "creators"("chainId", "address");

-- CreateIndex
CREATE UNIQUE INDEX "pools_tokenId_key" ON "pools"("tokenId");

-- CreateIndex
CREATE INDEX "pools_currency0_currency1_idx" ON "pools"("currency0", "currency1");

-- CreateIndex
CREATE UNIQUE INDEX "pools_poolId_key" ON "pools"("poolId");

-- CreateIndex
CREATE INDEX "volume_snapshots_tokenId_windowStart_idx" ON "volume_snapshots"("tokenId", "windowStart" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "volume_snapshots_tokenId_windowStart_venue_key" ON "volume_snapshots"("tokenId", "windowStart", "venue");

-- CreateIndex
CREATE INDEX "candles_tokenId_interval_openTime_idx" ON "candles"("tokenId", "interval", "openTime" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "candles_tokenId_interval_openTime_key" ON "candles"("tokenId", "interval", "openTime");

-- CreateIndex
CREATE INDEX "fee_events_tokenId_timestamp_idx" ON "fee_events"("tokenId", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "fee_events_chainId_transactionHash_logIndex_key" ON "fee_events"("chainId", "transactionHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "indexer_state_chainId_stream_key" ON "indexer_state"("chainId", "stream");

-- CreateIndex
CREATE INDEX "failed_blocks_resolved_lastFailedAt_idx" ON "failed_blocks"("resolved", "lastFailedAt");

-- CreateIndex
CREATE UNIQUE INDEX "failed_blocks_chainId_stream_blockNumber_key" ON "failed_blocks"("chainId", "stream", "blockNumber");

-- CreateIndex
CREATE INDEX "competitions_isActive_startsAt_idx" ON "competitions"("isActive", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "competitions_chainId_slug_key" ON "competitions"("chainId", "slug");

-- CreateIndex
CREATE INDEX "competition_participants_competitionId_qualifyingVolume_idx" ON "competition_participants"("competitionId", "qualifyingVolume" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "competition_participants_competitionId_walletAddress_key" ON "competition_participants"("competitionId", "walletAddress");

-- CreateIndex
CREATE INDEX "competition_rewards_walletAddress_idx" ON "competition_rewards"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "competition_rewards_competitionId_rank_key" ON "competition_rewards"("competitionId", "rank");

-- CreateIndex
CREATE INDEX "admin_audit_log_actorAddress_createdAt_idx" ON "admin_audit_log"("actorAddress", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_log_targetType_targetId_idx" ON "admin_audit_log"("targetType", "targetId");

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holders" ADD CONSTRAINT "holders_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transfers" ADD CONSTRAINT "token_transfers_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pools" ADD CONSTRAINT "pools_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volume_snapshots" ADD CONSTRAINT "volume_snapshots_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candles" ADD CONSTRAINT "candles_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_events" ADD CONSTRAINT "fee_events_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_participants" ADD CONSTRAINT "competition_participants_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_rewards" ADD CONSTRAINT "competition_rewards_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
