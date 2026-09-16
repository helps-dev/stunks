/**
 * How many curve addresses does one curve-stream tick filter on?
 *
 * The RPC providers cap address selectors at 1,000 per eth_getLogs call, so this count
 * decides how many separate requests every single tick has to make. Under the free
 * endpoints' rate limits that request count, not latency, is what stalls the stream.
 */
import { ROBINHOOD_CHAIN_ID } from "@stunks/config";
import { createRepositories, getPrisma } from "@stunks/database";
import { MAX_LOG_ADDRESSES_PER_QUERY } from "../src/sources/rpc.js";

const CURVE_TOPIC_COUNT = 7; // CURVE_EVENT_NAMES length; counted against the same cap

async function main(): Promise<void> {
  const prisma = getPrisma();
  const repos = createRepositories(prisma);

  const curves = await repos.tokens.listActiveCurves(ROBINHOOD_CHAIN_ID);
  const total = await prisma.token.count({ where: { chainId: ROBINHOOD_CHAIN_ID } });
  const perChunk = MAX_LOG_ADDRESSES_PER_QUERY - CURVE_TOPIC_COUNT;
  const chunks = Math.max(1, Math.ceil(curves.length / perChunk));

  console.log(`tokens (all phases)     ${total}`);
  console.log(`active curves           ${curves.length}`);
  console.log(`addresses per request   ${perChunk}`);
  console.log(`requests per tick       ${chunks}`);

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
