/**
 * Database verification against the real Postgres instance.
 *
 *   pnpm verify:db
 *
 * "The connection worked" is not the thing worth proving. The thing worth proving
 * is that a uint256 survives the round trip, because that is where precision dies
 * in most Web3 codebases: a money column read back as a float silently becomes
 * garbage, and nothing fails loudly.
 *
 * So this script writes real verified on-chain values, reads them back, and asserts
 * exact equality. It also proves the idempotency constraint that makes indexer
 * restarts safe, and the column types actually applied by the migration.
 *
 * Everything it creates is cleaned up, so it is safe to re-run.
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { toBigInt, toDecimal } from "@stunks/database";

const prisma = new PrismaClient();

let checks = 0;
let failures = 0;

function pass(label: string, detail = ""): void {
  checks++;
  console.log(`  PASS  ${label}${detail ? `  ${detail}` : ""}`);
}

function fail(label: string, detail: string): void {
  checks++;
  failures++;
  console.log(`  FAIL  ${label}\n        ${detail}`);
}

function section(title: string): void {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

function expectBigInt(label: string, actual: bigint, expected: bigint): void {
  if (actual === expected) pass(label, `= ${actual}`);
  else fail(label, `expected ${expected}, got ${actual}`);
}

/** Values taken from the Phase 0 audit, so this exercises realistic magnitudes. */
const VERIFIED = {
  /** Live Pons config 0 supply: 1e27. */
  supply: 1_000_000_000_000_000_000_000_000_000n,
  /** Tokens out for a 1 ETH buy on the reference curve, verified against eth_call. */
  tokensOut: 366_037_735_849_056_603_773_584_905n,
  /** reservedTokens(), verified byte-exact on-chain. */
  reserved: 285_714_285_714_285_714_285_714_285n,
  graduationThreshold: 4_200_000_000_000_000_000n,
  phantomQuote: 1_680_000_000_000_000_000n,
  /** The absolute uint256 ceiling — the widest value a column must hold. */
  uint256Max: 2n ** 256n - 1n,
} as const;

const CHAIN_ID = 4663;
const MARKER = "verify-db-probe";

async function cleanup(): Promise<void> {
  // Delete children first; Trade cascades from Token but Creator does not.
  await prisma.trade.deleteMany({ where: { chainId: CHAIN_ID, blockHash: MARKER } });
  await prisma.token.deleteMany({ where: { chainId: CHAIN_ID, launchTxHash: MARKER } });
  await prisma.creator.deleteMany({ where: { chainId: CHAIN_ID, address: MARKER } });
  await prisma.indexerState.deleteMany({ where: { chainId: CHAIN_ID, stream: MARKER } });
}

async function verifyConnection(): Promise<void> {
  section("1. Connection");
  const rows = await prisma.$queryRaw<{ db: string; version: string }[]>`
    SELECT current_database() AS db, version() AS version
  `;
  const row = rows[0];
  if (!row) {
    fail("connected", "no rows returned from identity query");
    return;
  }
  pass("connected", `database "${row.db}"`);
  console.log(`  INFO  ${row.version.split(",")[0]}`);
}

async function verifyColumnTypes(): Promise<void> {
  section("2. Column types applied by the migration");

  // Column names are camelCase (tables are snake_case) — see the convention note in
  // prisma/schema.prisma. Raw SQL must quote them.
  const columns = await prisma.$queryRaw<
    {
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }[]
  >`
    SELECT column_name, data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'trades'
      AND column_name IN (
        'tokenAmount', 'quoteAmount', 'price', 'marketCap',
        'feeAmount', 'creatorTaxAmount', 'snipeTaxAmount', 'refundAmount'
      )
    ORDER BY column_name
  `;

  if (columns.length === 0) {
    fail("money columns exist on trades", "information_schema returned nothing");
    return;
  }

  for (const column of columns) {
    const correct =
      column.data_type === "numeric" &&
      column.numeric_precision === 78 &&
      column.numeric_scale === 0;
    if (correct) {
      pass(`trades.${column.column_name}`, "numeric(78,0)");
    } else {
      fail(
        `trades.${column.column_name}`,
        `expected numeric(78,0), got ${column.data_type}(${column.numeric_precision},${column.numeric_scale})`,
      );
    }
  }

  // A money column stored as double precision would be a silent catastrophe.
  const floats = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('double precision', 'real')
  `;
  if (floats.length === 0) {
    pass("no floating-point columns anywhere in the schema");
  } else {
    fail(
      "floating-point columns found",
      floats.map((f) => `${f.table_name}.${f.column_name}`).join(", "),
    );
  }
}

async function verifyUint256RoundTrip(): Promise<void> {
  section("3. uint256 round trip through the database");

  const creator = await prisma.creator.create({
    data: { chainId: CHAIN_ID, address: MARKER, totalVolume: toDecimal(VERIFIED.supply) },
  });

  const token = await prisma.token.create({
    data: {
      chainId: CHAIN_ID,
      address: MARKER,
      name: "Verify Probe",
      symbol: "PROBE",
      creatorAddress: MARKER,
      deployerAddress: MARKER,
      curveAddress: MARKER,
      pairTokenAddress: MARKER,
      launchConfigId: 0n,
      totalSupply: toDecimal(VERIFIED.supply),
      creatorTaxBps: 200,
      buybackEnabled: true,
      graduationThreshold: toDecimal(VERIFIED.graduationThreshold),
      poolFee: 0,
      tickSpacing: 200,
      phantomQuote: toDecimal(VERIFIED.phantomQuote),
      reservedTokens: toDecimal(VERIFIED.reserved),
      launchBlock: 26_841_846n,
      launchTxHash: MARKER,
      creatorId: creator.id,
    },
  });

  const readBack = await prisma.token.findUniqueOrThrow({
    where: { chainId_address: { chainId: CHAIN_ID, address: MARKER } },
  });

  expectBigInt("totalSupply (1e27)", toBigInt(readBack.totalSupply), VERIFIED.supply);
  expectBigInt("reservedTokens", toBigInt(readBack.reservedTokens), VERIFIED.reserved);
  expectBigInt("phantomQuote", toBigInt(readBack.phantomQuote), VERIFIED.phantomQuote);
  expectBigInt(
    "graduationThreshold",
    toBigInt(readBack.graduationThreshold),
    VERIFIED.graduationThreshold,
  );
  // BigInt columns (block numbers) matter too: 852,912 blocks/day gets large.
  expectBigInt("launchBlock (BigInt column)", readBack.launchBlock, 26_841_846n);

  // The widest possible value a money column must hold.
  await prisma.token.update({
    where: { id: token.id },
    data: { volumeTotal: toDecimal(VERIFIED.uint256Max) },
  });
  const atMax = await prisma.token.findUniqueOrThrow({ where: { id: token.id } });
  expectBigInt("uint256 maximum", toBigInt(atMax.volumeTotal), VERIFIED.uint256Max);

  // The verified quote vector, stored and read as a trade amount.
  await prisma.trade.create({
    data: {
      chainId: CHAIN_ID,
      transactionHash: MARKER,
      logIndex: 0,
      blockNumber: 63_444_887n,
      blockHash: MARKER,
      tokenId: token.id,
      traderAddress: MARKER,
      recipientAddress: MARKER,
      side: "BUY",
      tokenAmount: toDecimal(VERIFIED.tokensOut),
      quoteAmount: toDecimal(1_000_000_000_000_000_000n),
      feeAmount: toDecimal(10_000_000_000_000_000n),
      creatorTaxAmount: toDecimal(20_000_000_000_000_000n),
      price: toDecimal(2_731_958_762n),
      marketCap: toDecimal(VERIFIED.supply),
      timestamp: new Date(),
    },
  });

  const trade = await prisma.trade.findUniqueOrThrow({
    where: {
      chainId_transactionHash_logIndex: {
        chainId: CHAIN_ID,
        transactionHash: MARKER,
        logIndex: 0,
      },
    },
  });
  expectBigInt(
    "verified quote vector as a trade amount",
    toBigInt(trade.tokenAmount),
    VERIFIED.tokensOut,
  );

  // Prove the digits survived in Postgres itself, not just through Prisma's
  // Decimal. Casting to text bypasses any client-side numeric handling.
  const raw = await prisma.$queryRaw<{ amount: string }[]>`
    SELECT "tokenAmount"::text AS amount
    FROM trades
    WHERE "chainId" = ${CHAIN_ID}
      AND "transactionHash" = ${MARKER}
      AND "logIndex" = 0
  `;
  if (raw[0]?.amount === VERIFIED.tokensOut.toString()) {
    pass("digits intact in Postgres itself", raw[0].amount);
  } else {
    fail("raw text from Postgres", `got ${raw[0]?.amount ?? "nothing"}`);
  }
}

async function verifyIdempotency(): Promise<void> {
  section("4. Idempotency — what makes an indexer restart safe");

  const token = await prisma.token.findUniqueOrThrow({
    where: { chainId_address: { chainId: CHAIN_ID, address: MARKER } },
  });

  // Replaying the same log must not create a second trade.
  try {
    await prisma.trade.create({
      data: {
        chainId: CHAIN_ID,
        transactionHash: MARKER,
        logIndex: 0,
        blockNumber: 63_444_887n,
        blockHash: MARKER,
        tokenId: token.id,
        traderAddress: MARKER,
        recipientAddress: MARKER,
        side: "BUY",
        tokenAmount: toDecimal(1n),
        quoteAmount: toDecimal(1n),
        feeAmount: toDecimal(0n),
        creatorTaxAmount: toDecimal(0n),
        price: toDecimal(1n),
        marketCap: toDecimal(1n),
        timestamp: new Date(),
      },
    });
    fail(
      "duplicate log rejected",
      "a second row with the same (chainId, txHash, logIndex) was accepted",
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      pass("duplicate log rejected by unique constraint", "(chainId, txHash, logIndex)");
    } else {
      fail("duplicate log rejected", `unexpected error: ${String(error)}`);
    }
  }

  // The upsert pattern the indexer will actually use.
  const upsertOnce = async () =>
    prisma.trade.upsert({
      where: {
        chainId_transactionHash_logIndex: {
          chainId: CHAIN_ID,
          transactionHash: MARKER,
          logIndex: 1,
        },
      },
      create: {
        chainId: CHAIN_ID,
        transactionHash: MARKER,
        logIndex: 1,
        blockNumber: 63_444_888n,
        blockHash: MARKER,
        tokenId: token.id,
        traderAddress: MARKER,
        recipientAddress: MARKER,
        side: "SELL",
        tokenAmount: toDecimal(VERIFIED.reserved),
        quoteAmount: toDecimal(5n),
        feeAmount: toDecimal(0n),
        creatorTaxAmount: toDecimal(0n),
        price: toDecimal(1n),
        marketCap: toDecimal(1n),
        timestamp: new Date(),
      },
      update: {},
    });

  await upsertOnce();
  await upsertOnce();
  await upsertOnce();

  const count = await prisma.trade.count({
    where: { chainId: CHAIN_ID, transactionHash: MARKER, logIndex: 1 },
  });
  if (count === 1) pass("three identical upserts produced one row");
  else fail("upsert idempotency", `expected 1 row, found ${count}`);

  // Checkpoint with a block hash, so a reorg is detectable rather than assumed away.
  await prisma.indexerState.create({
    data: {
      chainId: CHAIN_ID,
      stream: MARKER,
      lastProcessedBlock: 63_444_888n,
      lastProcessedBlockHash: MARKER,
    },
  });
  const state = await prisma.indexerState.findUniqueOrThrow({
    where: { chainId_stream: { chainId: CHAIN_ID, stream: MARKER } },
  });
  expectBigInt("checkpoint block", state.lastProcessedBlock, 63_444_888n);
  if (state.lastProcessedBlockHash === MARKER) {
    pass(
      "checkpoint stores a block hash",
      "reorgs detectable by parent-hash discontinuity",
    );
  } else {
    fail("checkpoint block hash", "not persisted");
  }
  if (state.confirmationDepth > 0) {
    pass("confirmation depth defaulted", `= ${state.confirmationDepth}`);
  }
}

async function verifyIndexes(): Promise<void> {
  section("5. Indexes the Explore and leaderboard queries depend on");
  const indexes = await prisma.$queryRaw<{ tablename: string; indexname: string }[]>`
    SELECT tablename, indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('tokens', 'trades', 'holders', 'candles')
  `;
  const count = indexes.length;
  if (count >= 10) {
    pass("indexes present", `${count} across tokens/trades/holders/candles`);
  } else {
    fail("indexes present", `only ${count} found; expected the schema's declared set`);
  }

  const tables = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
  console.log(`  INFO  ${tables[0]?.count ?? 0n} tables in public schema`);
}

async function main(): Promise<void> {
  console.log("STUNKS.FUN — database verification");

  await cleanup();
  try {
    await verifyConnection();
    await verifyColumnTypes();
    await verifyUint256RoundTrip();
    await verifyIdempotency();
    await verifyIndexes();
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  section("Result");
  console.log(`  ${checks} checks, ${failures} failed`);
  if (failures > 0) {
    console.log(
      "\n  A failure here means money can be silently corrupted on its way to or from\n" +
        "  the database. Do not build the indexer on top of it.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      "\n  uint256 values survive the round trip exactly. Probe rows cleaned up.",
    );
  }
}

main().catch(async (error: unknown) => {
  console.error(
    "\nVerification aborted:",
    error instanceof Error ? error.message : error,
  );
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
