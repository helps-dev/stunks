/**
 * How much data would a region migration have to move?
 *
 * Neon fixes a project's region at creation, so moving the database to be near the
 * server means creating a new project and copying into it. This reports the size that
 * copy has to carry.
 */
import { getPrisma } from "@stunks/database";

interface SizeRow {
  readonly table: string;
  readonly rows: bigint;
  readonly size: string;
}

async function main(): Promise<void> {
  const prisma = getPrisma();

  const total = await prisma.$queryRaw<{ size: string }[]>`
    SELECT pg_size_pretty(pg_database_size(current_database())) AS size
  `;

  const tables = await prisma.$queryRaw<SizeRow[]>`
    SELECT
      c.relname AS table,
      c.reltuples::bigint AS rows,
      pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `;

  console.log(`database total    ${total[0]?.size ?? "unknown"}`);
  console.log("");
  console.log("table                        est. rows        size");
  for (const row of tables) {
    console.log(`${row.table.padEnd(28)} ${String(row.rows).padStart(10)}  ${row.size}`);
  }

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
