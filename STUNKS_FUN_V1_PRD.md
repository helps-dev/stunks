# STUNKS.FUN V1 — Product Requirements Document (PRD)

**Document Status:** Engineering Ready  
**Version:** V1.0  
**Product:** STUNKS.FUN  
**Network:** Robinhood Chain  
**Infrastructure:** Pons V2  
**Primary Goal:** Launch, discover, trade, and compete around tokens launched through Pons V2.

---

## 1. Executive Summary

**STUNKS.FUN** adalah platform launchpad dan trading Web3 yang menyediakan pengalaman pengguna sendiri di atas infrastruktur **Pons V2**.

Pengguna berinteraksi sepenuhnya dengan STUNKS.FUN:

> Launch → Trade → Monitor → Discover → Compete

Sedangkan proses blockchain di belakang layar menggunakan:

> **Pons V2 + Robinhood Chain + Uniswap V4**

STUNKS.FUN **bukan custodial exchange** dan tidak menyimpan aset atau private key pengguna.

### Positioning

> **STUNKS.FUN — Launch. Trade. Compete.**

### Konsep Utama

```text
                  STUNKS.FUN
                       │
       ┌───────────────┼────────────────┐
       │               │                │
     LAUNCH           TRADE          DISCOVER
       │               │                │
       └───────────────┼────────────────┘
                       │
                Pons V2 Adapter
                       │
              ┌────────┴────────┐
              │                 │
       Pons V2 Contracts    STUNKS Indexer
              │                 │
              └────────┬────────┘
                       │
                Robinhood Chain
                       │
                  Uniswap V4
```

---

# 2. Problem Statement

Saat ini pengguna yang ingin meluncurkan atau memperdagangkan memecoin harus berinteraksi langsung dengan berbagai infrastructure layer.

Masalah yang ingin diselesaikan STUNKS:

### Untuk Creator

- Launch process harus sederhana.
- Tidak perlu memahami smart contract secara mendalam.
- Creator membutuhkan dashboard token.
- Creator ingin melihat volume dan earnings.
- Creator membutuhkan exposure/discovery.

### Untuk Trader

- Sulit menemukan token baru yang menarik.
- Informasi tersebar.
- Tidak ada discovery layer yang kuat.
- Tidak ada leaderboard/trading competition yang menarik.
- UX launchpad dan trading sering terasa berbeda-beda.

### Untuk Ekosistem

Pons menyediakan infrastructure.

STUNKS menyediakan:

> **distribution + UX + discovery + analytics + competition.**

---

# 3. Product Vision

STUNKS.FUN ingin menjadi:

> **The primary discovery, launch, and trading interface for tokens powered by Pons infrastructure on Robinhood Chain.**

Jangka panjang:

```text
Pons
Infrastructure

STUNKS
Product

Robinhood
Network
```

STUNKS tidak perlu bersaing dengan Pons dalam hal smart contract infrastructure.

STUNKS bersaing dalam:

- UX
- Liquidity discovery
- Creator acquisition
- Trader acquisition
- Analytics
- Competitions
- Community
- Distribution

---

# 4. Product Principles

## 4.1 Non-Custodial

STUNKS tidak menyimpan:

- Private key
- Seed phrase
- User funds

Semua transaksi membutuhkan signature user.

---

## 4.2 On-Chain First

Blockchain adalah source of truth.

Database STUNKS hanya merupakan:

> Indexed representation of blockchain state.

Jika database berbeda dengan blockchain:

> **Blockchain wins.**

---

## 4.3 Pons-Compatible

STUNKS tidak mengganti:

- Pons bonding curve
- Pons factory
- Pons graduation
- Pons fee system
- Uniswap V4 liquidity

kecuali memang diperlukan dan sudah diverifikasi secara teknis.

---

## 4.4 Fast

Target:

- Homepage initial load < 2.5 detik
- Token page initial data < 2 detik
- Chart loading < 1.5 detik
- Trade quote < 500 ms jika RPC sehat

---

## 4.5 Professional

UI tidak boleh terlihat seperti:

- Demo
- Hackathon
- Template crypto
- Indie project

Target visual:

> **Professional Web3 trading terminal.**

---

# 5. Target Users

## 5.1 Token Creator

Orang yang ingin membuat token dengan cepat.

Needs:

- Simple launch
- Branding
- Token page
- Social links
- Analytics
- Creator earnings
- Exposure

---

## 5.2 Trader

Trader memanfaatkan STUNKS untuk:

- Menemukan token
- Membeli
- Menjual
- Melihat chart
- Melihat volume
- Mencari token yang sedang trending
- Mengikuti competition

---

## 5.3 Alpha Hunter

User yang fokus mencari token baru:

- Newly launched
- High volume acceleration
- High buy pressure
- Near graduation
- Early momentum

---

## 5.4 Competitive Trader

Trader yang tertarik:

- Leaderboard
- Trading volume
- Rewards
- Competitions

---

# 6. Core User Journey

## Creator

```text
Connect Wallet
       ↓
Launch
       ↓
Token deployed
       ↓
Token appears on STUNKS
       ↓
Share token
       ↓
Trading
       ↓
Volume
       ↓
Creator earnings
```

## Trader

```text
STUNKS
   ↓
Explore
   ↓
Token
   ↓
Chart
   ↓
Buy
   ↓
Monitor
   ↓
Sell
```

## Competitive Trader

```text
STUNKS
   ↓
Competition
   ↓
Trade
   ↓
Volume indexed
   ↓
Leaderboard
   ↓
Competition ends
   ↓
Reward
```

---

# 7. Product Scope

## V1 P0

### Launchpad

- Connect wallet
- Create token
- Launch token melalui Pons V2
- Launch configuration
- Transaction status
- Token page

### Trading

- Buy
- Sell
- Quote
- Slippage
- Transaction status
- Curve trading
- Graduated V4 trading

### Discovery

- Explore
- New
- Trending
- Volume
- Market cap
- Graduating
- Graduated

### Analytics

- Price
- Market cap
- Volume
- Trades
- Holders
- Chart
- Recent transactions

---

# 8. V1 P1

- Trader leaderboard
- Creator leaderboard
- Trading competition
- Creator profile
- Token verification
- Featured token
- Trending score
- Graduation alerts

---

# 9. V1 P2

- Creator dashboard
- Creator earnings analytics
- Platform revenue analytics
- Rewards dashboard
- Advanced analytics

---

# 10. Explicitly Out of Scope

Jangan membangun untuk V1:

- NFT marketplace
- DAO
- Governance
- Lending
- Staking
- Farming
- Perpetuals
- Copy trading
- AI trading bot
- Mobile application
- Multi-chain launch
- Social network
- Chat
- Messaging

---

# 11. Homepage Requirements

URL:

```text
/
```

## Hero

```text
STUNKS.FUN

Launch. Trade. Compete.

[ Launch Token ]
[ Explore Tokens ]
```

## Trending Section

Menampilkan:

- Token
- Price
- Market cap
- Volume
- Graduation progress

Contoh:

```text
TRENDING

$ABC
$125K MC
$82K VOL
84%

$XYZ
$93K MC
$51K VOL
62%
```

## New Launches

Menampilkan token terbaru.

Sorting:

```text
Newest
```

## Graduating Soon

Menampilkan token berdasarkan graduation progress.

## Leaderboard Preview

Menampilkan Top 5 traders.

---

# 12. Explore Page

URL:

```text
/explore
```

Tabs:

```text
Trending
New
Volume
Market Cap
Graduating
Graduated
```

Filters:

```text
Search
Time
Minimum volume
Market cap
Phase
```

---

# 13. Token Card

Setiap token card harus menampilkan:

```text
Token image

$ABC
ABC Token

$125,421
Market Cap

$82,421
Volume 24H

84%
Graduation

+12.4%
```

Optional:

```text
🔥 Trending
✓ Verified
```

---

# 14. Token Page

URL:

```text
/token/[tokenAddress]
```

Ini adalah halaman paling penting di platform.

## Header

```text
[Token Image]

$ABC

ABC Token

Creator:
0x123...ABC

Market Cap
$125,421

Volume 24H
$82,421
```

---

# 15. Token Chart

Chart harus menyediakan:

```text
1m
5m
15m
1H
4H
1D
```

Jenis data:

```text
OHLC
Volume
```

Source:

> Indexed on-chain trades.

Bukan data dummy.

---

# 16. Trading Panel

Desktop:

```text
BUY | SELL
```

Amount:

```text
[ 0.1 ETH ]
```

Slippage:

```text
0.5%
1%
3%
5%
Custom
```

Preview:

```text
You pay
0.1 ETH

Estimated receive
123,421 ABC

Price impact
0.82%

Trading fee
...

Minimum received
...
```

Button:

```text
BUY ABC
```

---

# 17. Transaction State

Saat user submit:

```text
Confirm in wallet
```

Setelah signature:

```text
Transaction pending...
```

Setelah mined:

```text
Transaction confirmed
```

Link:

```text
View transaction
```

Jika gagal:

```text
Transaction failed
```

Dengan alasan yang sebisa mungkin readable.

---

# 18. Trade History

Tabel:

| Time | Trader    | Type | Amount |   Price |
| ---- | --------- | ---- | -----: | ------: |
| 10s  | 0x82...91 | BUY  |   $500 |  $0.001 |
| 20s  | 0x12...AB | SELL |   $120 | $0.0009 |

BUY dan SELL harus dibedakan secara visual.

---

# 19. Holders

Menampilkan:

```text
Holders
1,284
```

Tabel:

```text
Rank
Wallet
Balance
Percentage
```

Jangan mengklaim balance real-time jika indexer belum sinkron.

---

# 20. Token Information

Menampilkan:

```text
Contract
Creator
Curve
Pair
Phase
Creator Tax
Launch Date
```

Contract address:

```text
0x123...456
[Copy]
[Explorer]
```

---

# 21. Graduation Progress

Untuk token curve:

```text
GRADUATION

84%

████████████████░░░░

$84,200 / $100,000
```

Progress harus berasal dari state Pons, bukan estimasi frontend.

---

# 22. Graduation State

States:

```text
CURVE
SWEEPING
GRADUATED
POOL_CREATED
RESCUED
```

UI harus mengikuti actual on-chain phase.

---

# 23. Launch Page

URL:

```text
/launch
```

Wizard:

## Step 1 — Token

```text
Name
Symbol
Image
Description
```

## Step 2 — Social

```text
Website
X
Telegram
Discord
Farcaster
```

## Step 3 — Configuration

Membaca configuration Pons secara dinamis.

## Step 4 — Review

```text
Token
Symbol
Creator
Tax
Buyback
Launch fee
```

## Step 5 — Launch

Wallet signature.

---

# 24. Launch Validation

Frontend:

- Name required
- Symbol required
- Image required
- Valid wallet
- Valid URLs
- Symbol length validation
- Name length validation

Backend:

> Jangan menjadi source of truth untuk blockchain rules.

Contract validation tetap dilakukan on-chain.

---

# 25. Launch Transaction

Flow:

```text
User
 ↓
STUNKS
 ↓
Read Pons config
 ↓
Prepare transaction
 ↓
Wallet
 ↓
User signs
 ↓
Pons Factory
 ↓
Token + Curve
 ↓
TokenLaunched
 ↓
Indexer
 ↓
Database
 ↓
STUNKS
```

---

# 26. Pons Integration Layer

Package:

```text
packages/pons
```

Responsibilities:

```text
getLaunchConfig()
getLaunch()
getCurve()
getPhase()
quoteBuy()
quoteSell()
launch()
buy()
sell()
```

Tidak boleh menambahkan fungsi Pons yang tidak terdapat dalam ABI aktual.

---

# 27. Trading Venue Resolver

Function:

```text
resolveTradingVenue(token)
```

Return:

```typescript
type TradingVenue =
  | {
      type: "CURVE";
      curve: Address;
    }
  | {
      type: "UNISWAP_V4";
      poolId: Hex;
      hook: Address;
    };
```

---

# 28. Buy Service

```text
quoteBuy()
```

Input:

```text
token
quoteAmount
slippage
```

Output:

```text
expectedTokens
minimumTokens
priceImpact
fee
```

---

# 29. Sell Service

```text
quoteSell()
```

Input:

```text
token
tokenAmount
slippage
```

Output:

```text
expectedQuote
minimumQuote
priceImpact
fee
```

---

# 30. Slippage

Default:

```text
1%
```

Presets:

```text
0.5%
1%
3%
5%
```

Custom:

```text
0.1%–50%
```

Warn user jika terlalu tinggi.

---

# 31. Indexer

Indexer merupakan salah satu komponen terpenting STUNKS.

```text
Robinhood RPC
       ↓
Block Scanner
       ↓
Event Decoder
       ↓
Event Processor
       ↓
PostgreSQL
       ↓
API
       ↓
Frontend
```

---

# 32. Indexer Requirements

Harus mendukung:

- Checkpoint
- Restart
- RPC failover
- Event deduplication
- Retry
- Database transaction
- Reorg handling
- Monitoring

---

# 33. Event Processing

## `TokenLaunched`

Create:

```text
Token
Launch
Creator
```

## `Buy`

Create:

```text
Trade
```

Update:

```text
Token volume
Token stats
Trader volume
Holder balance
```

## `Sell`

Same process.

## `PoolGraduated`

Update:

```text
Token.phase
Pool
Graduation
```

---

# 34. Database

Core tables:

```text
tokens
launches
trades
holders
token_transfers
creators
creator_tokens
pools
volume_snapshots
fee_events
competitions
competition_participants
competition_rewards
indexer_state
```

---

# 35. Token Database Schema

```text
tokens

id
chain_id
address

name
symbol
decimals

image_url
description

website_url
twitter_url
telegram_url
discord_url
farcaster_url

creator_address
deployer_address
curve_address
pair_token_address

launch_config_id

phase
creator_tax_bps
buyback_enabled

graduation_threshold
graduation_progress

price
market_cap
volume_24h

holder_count
trade_count

created_at
updated_at
```

Unique:

```text
(chain_id, address)
```

---

# 36. Trade Schema

```text
trades

id

token_id
curve_address

chain_id
transaction_hash
block_number
log_index

trader_address

side

token_amount
quote_amount

fee_amount
creator_tax_amount

price
market_cap

timestamp
```

Unique:

```text
(chain_id, transaction_hash, log_index)
```

---

# 37. Holder Schema

```text
holders

id
token_id
wallet_address
balance

first_seen_at
last_updated_at
```

Unique:

```text
(token_id, wallet_address)
```

---

# 38. Creator Schema

```text
creators

id
address

token_count
total_volume
total_fees

created_at
updated_at
```

---

# 39. Pool Schema

```text
pools

id
token_id

pool_id

currency0
currency1

hook_address
tick_spacing
pool_fee

graduated_at
graduation_tx_hash
```

---

# 40. API

Base:

```text
/api/v1
```

## Tokens

```text
GET /tokens
GET /tokens/:address
GET /tokens/:address/stats
GET /tokens/:address/trades
GET /tokens/:address/holders
GET /tokens/:address/candles
```

## Launches

```text
GET /launches
GET /launches/:address
```

## Creators

```text
GET /creators/:address
GET /creators/:address/tokens
```

## Leaderboards

```text
GET /leaderboard/traders
GET /leaderboard/creators
```

## Discovery

```text
GET /trending
GET /graduating
```

## Platform

```text
GET /platform/stats
```

---

# 41. API Pagination

Jangan gunakan offset untuk data besar.

Gunakan:

```text
cursor pagination
```

Contoh:

```text
GET /tokens?limit=50&cursor=abc
```

---

# 42. API Response Format

```json
{
  "data": [],
  "pagination": {
    "nextCursor": "...",
    "hasMore": true
  }
}
```

Error:

```json
{
  "error": {
    "code": "TOKEN_NOT_FOUND",
    "message": "Token not found"
  }
}
```

---

# 43. Trending Engine

Trending bukan hanya berdasarkan market cap.

Initial score:

```text
30% volume acceleration
25% unique traders
20% trade activity
15% buy pressure
10% market-cap growth
```

Semua bobot configurable.

---

# 44. Volume Calculation

Volume dihitung dari **actual on-chain trade events**.

Tidak boleh berasal dari:

- Frontend
- User input
- Creator input
- API pihak ketiga sebagai source utama

---

# 45. Market Cap

Untuk curve:

Gunakan actual curve state dan current price.

Jangan menggunakan:

```text
JavaScript Number
```

untuk nilai finansial.

Gunakan:

```text
bigint
Decimal
```

sesuai konteks.

---

# 46. Price Calculation

Indexer menyimpan:

```text
price
```

berdasarkan actual trade.

Untuk chart:

```text
trade events
     ↓
price aggregation
     ↓
OHLC candles
```

---

# 47. Trading Competition

Ini merupakan salah satu **unique selling point** STUNKS.

Example:

```text
STUNKS WEEKLY TRADING COMPETITION

$500 TOTAL PRIZE
```

Ranking berdasarkan:

```text
Trading volume
```

bukan profit.

---

# 48. Competition Rules

Default:

```text
Start:
Monday 00:00 UTC

End:
Sunday 23:59 UTC
```

Tetapi admin dapat membuat competition custom.

---

# 49. Leaderboard

```text
Rank
Wallet
Volume
Trades
```

Contoh:

```text
🥇 0x82...91
$482,931

🥈 0x31...AB
$293,821

🥉 0x91...CD
$183,292
```

---

# 50. Anti-Abuse

V1 harus memiliki mekanisme untuk mengurangi wash trading.

Minimum:

- Volume dihitung berdasarkan actual swaps
- Self-transfer tidak dihitung
- Reverted transaction tidak dihitung
- Duplicate events tidak dihitung
- Admin dapat mengecualikan wallet tertentu
- Competition rules dapat mengecualikan transaksi tertentu

Untuk V1, jangan menjanjikan deteksi wash trading sempurna.

---

# 51. Competition Reward

Contoh:

```text
$500

1st  $250
2nd  $100
3rd  $75
4th  $50
5th  $25
```

Ranking:

```text
Indexer
```

Reward:

```text
On-chain contract
```

---

# 52. Competition Contract

Potential:

```text
StunksCompetition.sol
```

Responsibilities:

- Competition registration
- Prize pool
- Reward claims
- Prevent duplicate claims

Tidak bertugas menentukan ranking.

---

# 53. Creator Dashboard

URL:

```text
/creator/[address]
```

Display:

```text
Tokens Created
Total Volume
Total Fees
```

Token list:

```text
Token
Volume
Market Cap
Creator Earnings
```

---

# 54. Platform Revenue

Dashboard internal:

```text
Total Trading Volume
Platform Revenue
Tokens Launched
Active Tokens
Graduated Tokens
```

**Jangan menampilkan STUNKS revenue yang belum benar-benar diterima on-chain.**

---

# 55. Fee Architecture

Ini harus dipisahkan dari MVP trading.

Pons V2 memiliki fee system sendiri.

STUNKS tidak boleh mengatakan:

> "10% of Pons trading fee goes to STUNKS"

sebelum jalur tersebut terbukti benar-benar tersedia.

Architecture:

```text
Pons Native Fee System
          │
          ▼
     Pons accounting
```

STUNKS:

```text
Fee Analytics
```

terlebih dahulu.

Kemudian:

```text
StunksFeeAdapter
```

hanya jika mekanisme fee-routing telah diverifikasi.

---

# 56. Fee Adapter

Interface awal:

```typescript
interface FeeAdapter {
  getPlatformFees(token: Address): Promise<FeeData>;
  getClaimableFees(): Promise<FeeData>;
}
```

Jangan mengasumsikan implementasi.

---

# 57. Creator Fee

STUNKS hanya menampilkan:

```text
Creator fee
```

berdasarkan actual Pons configuration.

Jika creator tax:

```text
2%
```

UI harus menampilkan:

```text
Creator Tax: 2%
```

---

# 58. Security Requirements

## Wallet

Tidak boleh ada private key di:

- Browser storage
- Database
- Backend
- Logs

## API

Gunakan:

- Rate limiting
- Input validation
- Address validation
- Authentication admin
- CORS
- Request logging

---

# 59. Smart Contract Security

Contract STUNKS V1 harus seminimal mungkin.

Core launch:

```text
Pons V2
```

Core curve:

```text
Pons V2
```

Core liquidity:

```text
Pons + Uniswap V4
```

STUNKS contract hanya untuk fitur yang benar-benar memerlukan on-chain state.

---

# 60. Admin System

Admin dashboard:

```text
Overview
Tokens
Creators
Trades
Competitions
Revenue
Indexer
System
```

---

# 61. Token Moderation

Admin dapat:

```text
Feature
Hide
Verify
Unverify
```

Admin **tidak dapat**:

- Modify token balance
- Modify token supply
- Modify user funds
- Alter Pons state

---

# 62. Verified Token

Verification bukan berarti:

> "STUNKS menjamin token aman."

Copy harus jelas:

> **Verified creator / verified identity**

bukan:

> **Safe token**

---

# 63. Scam Handling

Token dapat ditandai:

```text
Flagged
```

dan dikeluarkan dari:

```text
Trending
Featured
New
```

Tetapi token tetap ada on-chain.

STUNKS tidak dapat menghapus blockchain token.

---

# 64. RPC Architecture

Jangan gunakan satu RPC.

```text
RPC Primary
RPC Secondary
RPC Tertiary
```

Failover:

```text
Primary fails
    ↓
Secondary
    ↓
Tertiary
```

Indexer harus memonitor latency/error rate setiap endpoint.

---

# 65. Redis

Cache:

```text
trending
leaderboards
token stats
candles
platform stats
```

Contoh:

```text
token:{address}:stats
token:{address}:trades
trending:24h
leaderboard:7d
```

---

# 66. Observability

Monitor:

```text
RPC latency
RPC failures
Indexer lag
Database latency
Redis latency
API latency
Transaction failures
```

---

# 67. Indexer Health

Admin:

```text
Latest Chain Block
Indexed Block
Block Lag
Last Successful Sync
RPC Status
```

Target:

```text
Block lag < 10 blocks
```

untuk kondisi normal.

---

# 68. Notifications

V1 optional:

- Graduation notification
- Competition ending
- Competition winner

Jangan prioritaskan email/push notification sebelum core trading stabil.

---

# 69. Performance Requirements

Homepage:

```text
LCP < 2.5 sec
```

Token page:

```text
Initial data < 2 sec
```

API:

```text
P95 < 500ms
```

untuk cached endpoints.

---

# 70. Mobile

STUNKS harus responsive.

Prioritas:

```text
Desktop
Tablet
Mobile
```

Trading panel pada mobile:

```text
Chart
 ↓
BUY/SELL
 ↓
Stats
 ↓
Trades
```

---

# 71. SEO

Token pages harus memiliki:

```text
title
description
OG image
canonical
```

Contoh:

```text
$ABC — Trade on STUNKS.FUN
```

---

# 72. Share Preview

Token page harus menghasilkan OG preview:

```text
$ABC

Market Cap $125K
Volume $82K

STUNKS.FUN
```

---

# 73. Analytics

Internal product analytics:

```text
wallet connects
launches
trades
volume
unique traders
page views
token clicks
competition participation
```

Jangan menyimpan informasi sensitif yang tidak diperlukan.

---

# 74. Product Metrics

Primary KPI:

### GMV / Trading Volume

```text
Total volume traded through STUNKS
```

Secondary:

```text
Tokens launched
Active tokens
Daily traders
Weekly traders
Unique creators
Graduation rate
Competition participants
```

---

# 75. North Star Metric

> **Weekly Trading Volume through STUNKS**

Karena tujuan utama bukan sekadar jumlah token yang dibuat.

Token yang dibuat tetapi tidak diperdagangkan tidak menghasilkan ekosistem.

---

# 76. Creator KPI

```text
New creators
Repeat creators
Tokens per creator
Average volume per token
Creator retention
```

---

# 77. Trader KPI

```text
Daily active traders
Weekly active traders
Average volume/trader
Trades/trader
Competition participation
```

---

# 78. Launch Success Metrics

Launch dianggap sukses jika:

```text
Token deployed
+
Token indexed
+
First trade
```

Metrics:

```text
Time to first trade
Volume after 1h
Volume after 24h
Graduation rate
```

---

# 79. Failure Scenarios

## Pons RPC Down

STUNKS:

```text
Read-only degraded mode
```

Trading disabled sampai RPC kembali.

## Indexer Down

Frontend menampilkan:

```text
Data may be delayed
```

Blockchain trading tetap dapat berlangsung jika RPC/wallet transaction path tersedia.

## Database Down

Frontend tidak boleh mencoba membuat data blockchain palsu.

## Transaction Failed

Tampilkan:

```text
Transaction failed
```

Jangan menyatakan user berhasil membeli.

---

# 80. Transaction Confirmation

Frontend harus membedakan:

```text
wallet signed
```

dengan:

```text
transaction mined
```

dan:

```text
indexer processed
```

Ketiganya bukan hal yang sama.

---

# 81. Deployment Architecture

```text
                 Cloudflare
                     │
                     ▼
                  Vercel
                     │
                  Next.js
                     │
             ┌───────┴────────┐
             ▼                ▼
            API            WebSocket
             │
       ┌─────┴─────┐
       ▼           ▼
 PostgreSQL      Redis
       ▲
       │
    Indexer
       │
       ▼
 Robinhood RPC
```

---

# 82. Environment Variables

```text
CHAIN_ID
ROBINHOOD_RPC_PRIMARY
ROBINHOOD_RPC_SECONDARY
ROBINHOOD_RPC_TERTIARY

PONS_FACTORY
PONS_HOOK
PONS_ESCROW
PONS_BUYBACK
PONS_LOCKER
PONS_DEPLOYER
PONS_GRADUATION_EXECUTOR
PONS_GRADUATION_GUARD

DATABASE_URL
REDIS_URL

NEXT_PUBLIC_API_URL
```

Semua address harus diverifikasi sebelum production.

---

# 83. Testing

## Unit Tests

Test:

- Price calculation
- Market cap
- Graduation progress
- Trending score
- Slippage
- Volume
- Leaderboard

## Integration Tests

Test:

```text
Pons factory
Pons curve
Pons events
Database
Indexer
API
```

## End-to-End Tests

### Launch

```text
connect
→ launch
→ transaction
→ index
→ token appears
```

### Buy

```text
quote
→ sign
→ transaction
→ event
→ trade appears
```

### Sell

Same.

### Graduation

```text
threshold
→ graduation
→ pool
→ token phase
```

---

# 84. Testnet / Safe Environment

Sebelum production:

```text
local fork
+
available test environment
+
small-value mainnet validation
```

Jangan langsung menguji launch/trading production dengan jumlah besar.

---

# 85. Production Deployment Stages

### Stage 1

Indexer only.

### Stage 2

Read-only frontend.

### Stage 3

Launch.

### Stage 4

Buy/Sell.

### Stage 5

Analytics.

### Stage 6

Competition.

### Stage 7

Public launch.

---

# 86. V1 Milestones

## Milestone 1

```text
Repository
CI/CD
Database
Web3
Pons ABI
RPC
```

## Milestone 2

```text
Indexer
Token discovery
Trade indexing
```

## Milestone 3

```text
Launchpad
```

## Milestone 4

```text
Trading
```

## Milestone 5

```text
Charts
Analytics
```

## Milestone 6

```text
Leaderboard
Competition
```

---

# 87. Definition of Done

STUNKS V1 dianggap selesai apabila:

## Launch

- [ ] Wallet connect
- [ ] Token creation
- [ ] Pons launch
- [ ] Token indexed
- [ ] Token appears on Explore

## Trading

- [ ] Buy
- [ ] Sell
- [ ] Slippage
- [ ] Quote
- [ ] Transaction status
- [ ] Curve trading
- [ ] V4 trading

## Data

- [ ] Trades
- [ ] Volume
- [ ] Price
- [ ] Market cap
- [ ] Holders
- [ ] Chart
- [ ] Graduation

## Discovery

- [ ] New
- [ ] Trending
- [ ] Volume
- [ ] Graduating
- [ ] Graduated

## Competition

- [ ] Leaderboard
- [ ] Competition
- [ ] Volume calculation
- [ ] Rewards

## Infrastructure

- [ ] RPC failover
- [ ] Indexer checkpoint
- [ ] Event deduplication
- [ ] Database backup
- [ ] Monitoring
- [ ] Error handling

## Security

- [ ] No private key custody
- [ ] No user fund custody
- [ ] Contract addresses verified
- [ ] ABI verified
- [ ] Transaction simulation
- [ ] Admin authentication
- [ ] Rate limiting

---

# 88. Definition of Production Ready

Jangan menganggap:

> "Website sudah online"

sebagai production ready.

Production ready berarti:

```text
Smart contracts verified
        +
Pons integration verified
        +
Indexer reliable
        +
Trading tested
        +
Database backed up
        +
RPC failover
        +
Monitoring
        +
Security review
        +
Small-value live test
```

baru kemudian public launch.

---

# 89. Final Architecture

```text
                         STUNKS.FUN
                              │
             ┌────────────────┼────────────────┐
             │                │                │
           LAUNCH            TRADE          DISCOVERY
             │                │                │
             └────────────────┼────────────────┘
                              │
                        Web3 SDK
                              │
                     Pons Integration
                              │
                ┌─────────────┴─────────────┐
                │                           │
          Pons V2 Contracts             Indexer
                │                           │
       ┌────────┼────────┐                  │
       │        │        │                  │
     Factory   Curve   Graduation           │
       │        │        │                  │
       └────────┼────────┘                  │
                │                           │
                ▼                           ▼
         Robinhood Chain ◄──────────── PostgreSQL
                │                           │
                ▼                           ▼
           Uniswap V4                     API
                                            │
                                            ▼
                                         STUNKS
```

---

# 90. Strategic Differentiation

STUNKS tidak perlu berkata:

> "Kami punya bonding curve sendiri."

STUNKS justru mengatakan:

> **"Launch on STUNKS. Trade on STUNKS."**

Di belakang:

> **Powered by Pons V2.**

Differentiation:

```text
Pons
=
Infrastructure

STUNKS
=
Experience
+
Discovery
+
Analytics
+
Competition
+
Distribution
```

---

# 91. Recommended Engineering Documentation

Setelah PRD ini, development sebaiknya dibagi menjadi 4 dokumen engineering.

## 01 — Pons V2 Integration Specification

Mencakup:

- ABI
- Contract addresses
- Functions
- Events
- Quote
- Launch
- Buy
- Sell
- Graduation
- Fee flow
- Venue resolution

## 02 — STUNKS Database + Indexer Specification

Mencakup:

- Prisma schema
- Event decoder
- Block synchronization
- Reorg handling
- Volume calculation
- Candle engine
- Leaderboard calculation

## 03 — STUNKS Frontend Specification

Mencakup:

- Semua page
- Component architecture
- State management
- API contract
- Trading UX
- Responsive behavior
- Loading/error states

## 04 — STUNKS Smart Contract Specification

Mencakup:

- Competition
- Rewards
- Claim
- Future fee adapter

Contract tambahan hanya dibuat jika benar-benar diperlukan.

---

# 92. Important Implementation Rule

**Jangan mulai dengan membuat semua fitur sekaligus.**

Urutan yang direkomendasikan:

```text
Pons Integration
       ↓
Indexer
       ↓
Token Discovery
       ↓
Token Page
       ↓
Launch
       ↓
Buy/Sell
       ↓
Charts
       ↓
Leaderboard
       ↓
Competition
       ↓
Creator Dashboard
```

Prioritas utama:

> **Token launch + reliable indexing + working trading.**

Jika tiga bagian tersebut sudah stabil, fitur lainnya dapat dibangun di atas foundation yang sama.

---

# 93. Technical Rule for AI Coding Agents

Kiro, Claude Code, Cursor, atau AI coding agent lainnya **tidak boleh mengarang**:

- ABI
- Contract address
- Function signature
- Event signature
- Fee percentage
- Graduation threshold
- Pool configuration
- Pons API
- On-chain state

Jika informasi belum diketahui:

```text
STOP
→ inspect official ABI/source
→ verify on-chain
→ document result
→ continue implementation
```

Jangan mengganti data yang belum diketahui dengan dummy production values.

---

# 94. Final Product Definition

STUNKS.FUN V1 adalah:

> **A non-custodial token launchpad and trading platform on Robinhood Chain, using Pons V2 as its underlying launch and bonding-curve infrastructure, with a dedicated discovery layer, professional token trading interface, on-chain analytics, and competitive trading leaderboard/rewards.**

Core product:

```text
LAUNCH
TRADE
DISCOVER
ANALYZE
COMPETE
```

Core infrastructure:

```text
Robinhood Chain
+
Pons V2
+
Uniswap V4
+
STUNKS Indexer
+
PostgreSQL
+
Redis
```

Core philosophy:

> **Use existing protocol infrastructure where possible. Build proprietary product value where it matters.**
