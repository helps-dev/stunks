/**
 * Inspect what the indexer actually wrote.
 *
 *   pnpm inspect:indexed
 *
 * Read-only. Exists so that "the indexer ran" can be distinguished from "the indexer
 * stored correct data" — the two are not the same, and only the second one matters.
 */

import { PrismaClient } from "@prisma/client";
import { toBigInt } from "@stunks/database";
import { formatUnitsExact } from "@stunks/utils";

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  const [tokens, trades, creators, states] = await Promise.all([
    prisma.token.count(),
    prisma.trade.count(),
    prisma.creator.count(),
    prisma.indexerState.findMany(),
  ]);

  console.log("Indexed state");
  console.log(`  tokens    ${tokens}`);
  console.log(`  trades    ${trades}`);
  console.log(`  creators  ${creators}`);

  console.log("\nCheckpoints");
  for (const state of states) {
    console.log(
      `  ${state.stream.padEnd(10)} block ${state.lastProcessedBlock} ` +
        `window ${state.logWindowSize} ` +
        `${state.lastError ? `ERROR: ${state.lastError.slice(0, 60)}` : "clean"}`,
    );
  }

  const recent = await prisma.token.findMany({
    orderBy: { launchBlock: "desc" },
    take: 10,
  });

  if (recent.length > 0) {
    console.log("\nMost recent launches");
    console.log(
      `  ${"symbol".padEnd(12)} ${"block".padEnd(10)} ${"supply".padEnd(14)} ` +
        `${"price (wei/1e18)".padEnd(18)} phase`,
    );
    for (const token of recent) {
      const supply = formatUnitsExact(toBigInt(token.totalSupply), token.decimals);
      console.log(
        `  ${token.symbol.slice(0, 11).padEnd(12)} ${String(token.launchBlock).padEnd(10)} ` +
          `${supply.padEnd(14)} ${toBigInt(token.price).toString().padEnd(18)} ${token.phase}`,
      );
    }
  }

  // Integrity spot-checks. A launch whose numbers are wrong is worse than no launch.
  console.log("\nIntegrity");

  const zeroSupply = await prisma.token.count({ where: { totalSupply: 0 } });
  console.log(
    `  ${zeroSupply === 0 ? "PASS" : "FAIL"}  no token has zero supply (${zeroSupply})`,
  );

  const zeroPrice = await prisma.token.count({ where: { price: 0 } });
  console.log(
    `  ${zeroPrice === 0 ? "PASS" : "WARN"}  every launch has an opening price ` +
      `(${zeroPrice} without)`,
  );

  const missingCurve = await prisma.token.count({ where: { curveAddress: "" } });
  console.log(
    `  ${missingCurve === 0 ? "PASS" : "FAIL"}  every token has a curve address`,
  );

  // Verified identity: reserved = supply * phantom / (phantom + threshold).
  const sample = recent[0];
  if (sample) {
    const supply = toBigInt(sample.totalSupply);
    const phantom = toBigInt(sample.phantomQuote);
    const threshold = toBigInt(sample.graduationThreshold);
    const expected = (supply * phantom) / (phantom + threshold);
    const stored = toBigInt(sample.reservedTokens);
    console.log(
      `  ${expected === stored ? "PASS" : "FAIL"}  reservedTokens identity holds for ` +
        `${sample.symbol}`,
    );
  }

  const duplicates = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM (
      SELECT "chainId", "transactionHash", "logIndex", count(*)
      FROM trades GROUP BY 1,2,3 HAVING count(*) > 1
    ) dupes
  `;
  const dupeCount = duplicates[0]?.count ?? 0n;
  console.log(
    `  ${dupeCount === 0n ? "PASS" : "FAIL"}  no duplicate trade logs (${dupeCount})`,
  );

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
