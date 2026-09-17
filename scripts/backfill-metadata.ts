/**
 * Recover launch metadata — image, description, socials — from launch calldata.
 *
 *   pnpm backfill:metadata -- --dry-run          fetch and report, write nothing
 *   pnpm backfill:metadata -- --apply            write what was recovered
 *   pnpm backfill:metadata -- --apply --limit 500
 *   pnpm backfill:metadata -- --apply --retry    re-examine tokens already tried
 *
 * WHY THIS EXISTS. `Token.imageUrl` had a column from the first migration and was
 * NULL on all 24,762 rows, because nothing ever wrote it: the indexer reads name,
 * symbol, decimals and totalSupply from the ERC-20 and there is no image anywhere in
 * the factory. The value lives in the calldata of the launch transaction, and
 * `Token.launchTxHash` has been stored all along — so every one of those images has
 * been one `eth_getTransactionByHash` away since the day the table was populated.
 *
 * COST. One RPC call per token. It is a read against a hash that is already known, so
 * there is no scanning and no range to tune; the whole backfill is bounded by the RPC
 * pool's throughput. Tokens that have already been examined are skipped on the next
 * run, so this is safe to re-run and cheap to resume after an interruption.
 *
 * WHAT COUNTS AS EXAMINED. A token whose calldata yielded nothing is marked with
 * `metadataCheckedAt` rather than left NULL, so a re-run does not spend another RPC
 * call on the same miss forever. `--retry` clears that judgement for the misses only:
 * useful after the extractor learns a new launch shape, useless otherwise.
 */

import { Prisma } from "@prisma/client";
import { getPrisma } from "@stunks/database";
import { ROBINHOOD_CHAIN_ID, loadServerEnv } from "@stunks/config";
import { extractLaunchMetadata, normaliseImageUrl } from "@stunks/pons";
import { createReadClient } from "@stunks/web3";

/**
 * Transactions fetched at once.
 *
 * Bounded by the RPC pool, not the database. Twenty-five keeps every endpoint busy
 * without tripping the rate limits that the pool would otherwise have to back off
 * from — and a backoff costs far more than the concurrency saves.
 */
const FETCH_CONCURRENCY = 25;

/**
 * Rows per UPDATE statement.
 *
 * This was 500 and timed out against Neon's pooled host after 4,000 rows:
 *
 *   Timed out fetching a new connection from the connection pool
 *   (Current connection pool timeout: 10, connection limit: 17)
 *
 * The statements are wide — eight text columns per row — so 500 of them is a large
 * query, and a run of them holds a pooled connection long enough for the next acquire
 * to expire. 200 keeps each statement inside the timeout while still being one query
 * rather than two hundred.
 */
const WRITE_CHUNK = 200;

/**
 * Examined tokens buffered before a write.
 *
 * WRITING HAPPENS AS THE RUN PROGRESSES, NOT AT THE END. The first version gathered
 * all 24,926 results and wrote them last, so when the writes failed every one of
 * those RPC calls was thrown away — ten minutes of work lost to a connection timeout
 * in the final step. Interleaving means an interruption costs at most this many
 * tokens, and `metadataCheckedAt` makes the next run resume from where it stopped.
 */
const WRITE_EVERY = 1_000;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  // eslint-disable-next-line no-restricted-syntax -- a row count is not money
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`--${name} needs a positive number`);
    process.exit(1);
  }
  return parsed;
}

interface Recovered {
  readonly id: string;
  readonly symbol: string;
  readonly imageUrl: string | null;
  readonly description: string | null;
  readonly websiteUrl: string | null;
  readonly twitterUrl: string | null;
  readonly telegramUrl: string | null;
  readonly discordUrl: string | null;
  readonly farcasterUrl: string | null;
}

/** Empty string means "the creator left it blank", which is a NULL column. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, 1024);
}

/**
 * Write a buffer of examined tokens.
 *
 * `UPDATE ... FROM (VALUES)` writes a different value to each row in a single query,
 * which is what a small connection pool can actually serve — the alternative is one
 * query per token, and that is the shape that exhausted the pool in `score:trending`.
 */
async function writeBatch(
  prisma: ReturnType<typeof getPrisma>,
  rows: readonly Recovered[],
): Promise<number> {
  let written = 0;
  const checkedAt = new Date();
  for (let offset = 0; offset < rows.length; offset += WRITE_CHUNK) {
    const chunk = rows.slice(offset, offset + WRITE_CHUNK);
    const values = chunk.map(
      (row) => Prisma.sql`(
        ${row.id},
        ${row.imageUrl}::text,
        ${row.description}::text,
        ${row.websiteUrl}::text,
        ${row.twitterUrl}::text,
        ${row.telegramUrl}::text,
        ${row.discordUrl}::text,
        ${row.farcasterUrl}::text
      )`,
    );
    written += await prisma.$executeRaw`
      UPDATE tokens AS t
      SET "imageUrl"          = v.image,
          "description"       = v.description,
          "websiteUrl"        = v.website,
          "twitterUrl"        = v.twitter,
          "telegramUrl"       = v.telegram,
          "discordUrl"        = v.discord,
          "farcasterUrl"      = v.farcaster,
          "metadataCheckedAt" = ${checkedAt}
      FROM (VALUES ${Prisma.join(values)})
        AS v(id, image, description, website, twitter, telegram, discord, farcaster)
      WHERE t.id = v.id`;
  }
  return written;
}

async function main(): Promise<void> {
  const apply = flag("apply");
  const retry = flag("retry");
  const limit = numberArg("limit", 100_000);
  if (!apply && !flag("dry-run")) {
    console.error("Pass --dry-run or --apply.");
    process.exit(1);
  }

  const prisma = getPrisma();
  const chainId = ROBINHOOD_CHAIN_ID;

  if (retry && apply) {
    const cleared = await prisma.token.updateMany({
      where: { chainId, imageUrl: null, metadataCheckedAt: { not: null } },
      data: { metadataCheckedAt: null },
    });
    console.log(`retry         : ${cleared.count} previous misses reopened\n`);
  }

  const pending = await prisma.token.findMany({
    // `launchTxHash` is non-nullable, so every token is reachable — there is no
    // cohort that is out of range, only launches whose calldata shape is not
    // recognised.
    where: { chainId, metadataCheckedAt: null },
    select: { id: true, name: true, symbol: true, launchTxHash: true },
    orderBy: { launchBlock: "desc" },
    take: limit,
  });

  const total = await prisma.token.count({ where: { chainId } });
  const done = await prisma.token.count({
    where: { chainId, metadataCheckedAt: { not: null } },
  });
  console.log(`tokens        : ${total} total, ${done} already examined`);
  console.log(`to examine    : ${pending.length}`);
  console.log(`mode          : ${apply ? "APPLY" : "dry run"}\n`);
  if (pending.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  const stunks = createReadClient(loadServerEnv().RPC_ENDPOINTS);

  // Only the tokens not yet written live here. It is drained into the database every
  // WRITE_EVERY, so an interruption costs that buffer and nothing more.
  let buffer: Recovered[] = [];
  let missed = 0;
  let unusableUrl = 0;
  let fetchFailed = 0;
  let examined = 0;
  let withImage = 0;
  let written = 0;
  const sample: Recovered[] = [];

  const drain = async (): Promise<void> => {
    if (!apply || buffer.length === 0) return;
    written += await writeBatch(prisma, buffer);
    buffer = [];
  };

  for (let offset = 0; offset < pending.length; offset += FETCH_CONCURRENCY) {
    const batch = pending.slice(offset, offset + FETCH_CONCURRENCY);
    await Promise.all(
      batch.map(async (token) => {
        const tx = await stunks.client
          .getTransaction({ hash: token.launchTxHash as `0x${string}` })
          .catch(() => null);
        if (tx === null) {
          // Not buffered, so it stays unexamined and the next run tries again. An RPC
          // that would not answer is not evidence about the calldata.
          fetchFailed++;
          return;
        }
        const meta = extractLaunchMetadata(tx.input, {
          name: token.name,
          symbol: token.symbol,
        });
        if (meta === null) {
          missed++;
          // Still counted as examined: the calldata will not change, so re-fetching
          // it on every run would spend RPC calls to learn the same thing.
          buffer.push({
            id: token.id,
            symbol: token.symbol,
            imageUrl: null,
            description: null,
            websiteUrl: null,
            twitterUrl: null,
            telegramUrl: null,
            discordUrl: null,
            farcasterUrl: null,
          });
          return;
        }
        // Stored normalised, so the page does not have to decide what ipfs:// means
        // and the proxy is handed something it can fetch. An unusable value — a
        // sentence, a plaintext URL — is stored as NULL rather than as text that
        // would fail in an <img> on every page view.
        const image = normaliseImageUrl(meta.logo);
        if (image === null && meta.logo.trim() !== "") unusableUrl++;
        const row: Recovered = {
          id: token.id,
          symbol: token.symbol,
          imageUrl: image,
          description: orNull(meta.description),
          websiteUrl: orNull(meta.socials.website),
          twitterUrl: orNull(meta.socials.twitter),
          telegramUrl: orNull(meta.socials.telegram),
          discordUrl: orNull(meta.socials.discord),
          farcasterUrl: orNull(meta.socials.farcaster),
        };
        if (image !== null) {
          withImage++;
          if (sample.length < 8) sample.push(row);
        }
        buffer.push(row);
      }),
    );
    examined += batch.length;

    if (buffer.length >= WRITE_EVERY) {
      await drain();
      console.log(`  ${examined}/${pending.length} examined, ${withImage} with an image, ${written} written`);
    } else if (examined % 1_000 < FETCH_CONCURRENCY) {
      console.log(`  ${examined}/${pending.length} examined, ${withImage} with an image`);
    }
  }
  await drain();

  console.log(`\nexamined      : ${examined}`);
  console.log(`image found   : ${withImage}`);
  console.log(`no metadata   : ${missed} (wrapped or unknown launch shape)`);
  console.log(`unusable URL  : ${unusableUrl} (not https, not ipfs — stored as null)`);
  console.log(`fetch failed  : ${fetchFailed} (not marked, will retry next run)`);

  if (sample.length > 0) {
    console.log(`\nsample:`);
    for (const row of sample) {
      console.log(`  ${row.symbol.padEnd(14)} ${row.imageUrl!.slice(0, 64)}`);
    }
  }

  console.log(
    apply
      ? `\n${written} rows updated, ${withImage} now have an image.`
      : "\nDry run. Nothing was written.",
  );
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
