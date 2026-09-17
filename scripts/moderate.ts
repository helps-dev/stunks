/**
 * Set a token's moderation status, and record who did it.
 *
 * Why this exists as a script rather than an admin page: `ExploreRepository` already
 * hides `HIDDEN` and `FLAGGED` tokens from every listing, but nothing in the codebase
 * could ever SET either value. The filter was real and the lever did not exist, so on
 * an open launchpad — where anyone can deploy a token called `USDC` and STUNKS renders
 * its name — there was no way to act on an impersonation or a slur short of a manual
 * SQL statement, which leaves no record of who changed what.
 *
 * A page can come later. What could not wait is the lever and the audit trail.
 *
 *   pnpm moderate -- --token 0x… --status HIDDEN --actor 0x… --reason "impersonates USDC"
 *   pnpm moderate -- --token 0x… --status NORMAL --actor 0x… --reason "appeal upheld"
 *   pnpm moderate -- --list HIDDEN
 *
 * This writes to the database only. It never touches the chain: the token still
 * exists, still trades through Pons, and anyone holding it is unaffected. All this
 * changes is whether STUNKS lists it — which is the only thing STUNKS controls, and
 * saying so plainly matters more here than anywhere else in the product.
 */

import { isAddress } from "viem";
import { getPrisma } from "@stunks/database";
import { ROBINHOOD_CHAIN_ID } from "@stunks/config";

const STATUSES = ["NORMAL", "FEATURED", "VERIFIED", "HIDDEN", "FLAGGED"] as const;
type Status = (typeof STATUSES)[number];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function usage(message: string): never {
  console.error(`\n${message}\n`);
  console.error("Usage:");
  console.error(
    "  pnpm moderate -- --token <address> --status <STATUS> --actor <address> [--reason <text>]",
  );
  console.error("  pnpm moderate -- --list <STATUS>");
  console.error(`\nSTATUS is one of: ${STATUSES.join(", ")}`);
  console.error(
    "\nHIDDEN and FLAGGED are the two that remove a token from every listing.\n" +
      "FEATURED and VERIFIED are claims STUNKS makes on its own behalf — a token is\n" +
      "not verified because its creator says so, and marking one says STUNKS checked.\n",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const prisma = getPrisma();
  const list = arg("list");

  if (list !== undefined) {
    if (!STATUSES.includes(list as Status)) usage(`Unknown status: ${list}`);
    const tokens = await prisma.token.findMany({
      where: { chainId: ROBINHOOD_CHAIN_ID, moderationStatus: list as Status },
      select: { address: true, symbol: true, name: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    if (tokens.length === 0) {
      console.log(`No tokens with status ${list}.`);
    } else {
      console.log(`${tokens.length} token(s) with status ${list}:\n`);
      for (const token of tokens) {
        console.log(
          `  ${token.address}  ${token.symbol.padEnd(12)} ${token.name.slice(0, 40)}`,
        );
      }
    }
    await prisma.$disconnect();
    return;
  }

  const token = arg("token");
  const status = arg("status");
  const actor = arg("actor");
  const reason = arg("reason");

  if (!token || !isAddress(token)) usage("--token must be a valid EVM address");
  if (!status || !STATUSES.includes(status as Status)) {
    usage(`--status must be one of: ${STATUSES.join(", ")}`);
  }
  // Required, and not defaulted to something like "admin". An audit row whose actor
  // is a placeholder answers none of the questions an audit row exists to answer.
  if (!actor || !isAddress(actor)) {
    usage("--actor must be the EVM address of the person making this change");
  }

  const address = token.toLowerCase();
  const existing = await prisma.token.findUnique({
    where: { chainId_address: { chainId: ROBINHOOD_CHAIN_ID, address } },
    select: { id: true, symbol: true, name: true, moderationStatus: true },
  });

  if (!existing) {
    console.error(
      `\nNo indexed token at ${address}.\n` +
        `It may be a real launch the indexer has not reached yet — check the curve\n` +
        `stream's lag before concluding the token does not exist.\n`,
    );
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  if (existing.moderationStatus === status) {
    console.log(`${existing.symbol} is already ${status}. Nothing to do.`);
    await prisma.$disconnect();
    return;
  }

  // One transaction: a status change without its audit row is exactly the state this
  // script exists to prevent.
  await prisma.$transaction([
    prisma.token.update({
      where: { id: existing.id },
      data: { moderationStatus: status as Status },
    }),
    prisma.adminAuditLog.create({
      data: {
        actorAddress: actor.toLowerCase(),
        action: "SET_MODERATION_STATUS",
        targetType: "Token",
        targetId: existing.id,
        before: { moderationStatus: existing.moderationStatus },
        after: { moderationStatus: status },
        ...(reason !== undefined ? { reason } : {}),
      },
    }),
  ]);

  console.log(
    `\n${existing.symbol} (${address})\n` +
      `  ${existing.moderationStatus} -> ${status}\n` +
      `  by ${actor}\n` +
      `  reason: ${reason ?? "(none given)"}\n`,
  );
  if (status === "HIDDEN" || status === "FLAGGED") {
    console.log(
      "  This token is now excluded from explore, search and trending.\n" +
        "  Its direct /token/<address> page still resolves, and the token itself is\n" +
        "  untouched on-chain.\n",
    );
  }

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
