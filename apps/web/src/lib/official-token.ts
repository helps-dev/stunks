import { getPrisma } from "@stunks/database";
import { serialiseToken, tokenDetail } from "./queries";
import type { SerialisedToken } from "./queries";

/**
 * The project's own token, for the spotlight above the explore grid.
 *
 * FOUR WAYS THIS RETURNS NULL, AND ALL OF THEM RENDER NOTHING.
 *
 *   1. `NEXT_PUBLIC_OFFICIAL_TOKEN` is unset — the normal state before a launch.
 *   2. The address is set but the indexer has not reached the token yet. The factory
 *      stream runs about an hour behind the head, so there is a real window after a
 *      launch where this is the answer. An empty frame with the symbol and nothing
 *      else would be worse than no frame.
 *   3. The token is hidden or flagged by moderation. The spotlight is the most
 *      prominent placement on the site and must not be the one surface that ignores
 *      a moderation decision.
 *   4. The database is unreachable. The rest of the page still renders from its own
 *      queries, so one failed panel must not take the page with it.
 *
 * THE 24-HOUR CHANGE IS COMPUTED, NOT STORED, AND IS OFTEN ABSENT.
 *
 * `Token` holds only the current price. The comparison price comes from
 * `volume_snapshots`, the hourly aggregate that `rollup:aggregates` writes — the same
 * table `score:trending` reads, and the only price history that survives
 * `prune:trades`. A token with no snapshot from far enough back has no honest 24-hour
 * figure, so it returns null and the tile is not rendered. It is never zero: zero
 * means "the price did not move", which is a different claim.
 *
 * The window is anchored to the newest snapshot rather than to `now()`, for the same
 * reason the trending score is: the curve stream has run a day or more behind on this
 * deployment, and a wall-clock 24-hour window would then contain no snapshots at all.
 */

export interface PriceChange {
  /** Basis points, signed. Null when there is no comparable price to measure from. */
  readonly changeBps: number | null;
  /** How old the comparison price is, in hours. Null alongside `changeBps`. */
  readonly changeWindowHours: number | null;
}

export type OfficialToken = NonNullable<Awaited<ReturnType<typeof tokenDetail>>> &
  PriceChange & {
    /**
     * The same token in the shape the grid's card takes.
     *
     * Built here so the page can pin it to the front of the first page of results even
     * when the current sort would not have placed it there — a token sorted by "new"
     * drops off page one within minutes, and the point of a spotlight is that it does
     * not depend on that.
     */
    readonly card: SerialisedToken;
  };

/** The window this prefers, when there is enough history for it. */
const PREFERRED_WINDOW_HOURS = 24;

/**
 * The shortest window worth reporting.
 *
 * Below this a "change" is one or two hours of noise on a bonding curve, not a trend,
 * and putting a percentage on it would invite a reading it cannot support.
 */
const MIN_WINDOW_HOURS = 3;

/**
 * THE WINDOW IS WHATEVER HISTORY EXISTS, AND IS LABELLED WITH ITS REAL WIDTH.
 *
 * A fixed 24-hour requirement renders nothing for a long time after the aggregates
 * start: measured on this deployment, `volume_snapshots` held fifteen hours of
 * history in total, so every token would have returned null and the tile would never
 * have appeared. Rather than show nothing, this takes the oldest usable snapshot and
 * the component names the window it actually measured — "15H change", not "24H
 * change" over fifteen hours of data.
 */
const MAX_WINDOW_HOURS = 48;

interface ChangeRow {
  readonly closePrice: string;
  readonly hoursAgo: number;
}

async function priceChange(
  tokenId: string,
  currentPrice: bigint,
): Promise<PriceChange> {
  if (currentPrice === 0n) return { changeBps: null, changeWindowHours: null };

  const prisma = getPrisma();
  // Ordered by how close each snapshot is to the preferred window, so a token with a
  // full day of history measures 24 hours and one with less measures what it has.
  // Distances are from the newest snapshot, not from the clock — see the note above.
  const rows = await prisma.$queryRaw<ChangeRow[]>`
    WITH anchor AS (
      SELECT MAX("windowEnd") AS at FROM volume_snapshots WHERE "tokenId" = ${tokenId}
    ),
    aged AS (
      SELECT v."closePrice",
             EXTRACT(EPOCH FROM (a.at - v."windowEnd")) / 3600 AS hours_ago
      FROM volume_snapshots v, anchor a
      WHERE v."tokenId" = ${tokenId} AND v."closePrice" > 0
    )
    SELECT "closePrice"::text AS "closePrice", hours_ago AS "hoursAgo"
    FROM aged
    WHERE hours_ago >= ${MIN_WINDOW_HOURS} AND hours_ago <= ${MAX_WINDOW_HOURS}
    ORDER BY ABS(hours_ago - ${PREFERRED_WINDOW_HOURS}) ASC
    LIMIT 1`;

  const row = rows[0];
  if (row === undefined) return { changeBps: null, changeWindowHours: null };

  // eslint-disable-next-line no-restricted-syntax -- an elapsed-hours count is not money
  const hoursAgo = Math.round(Number(row.hoursAgo));

  const then = BigInt(row.closePrice.split(".")[0] ?? "0");
  if (then === 0n) return { changeBps: null, changeWindowHours: null };

  // Basis points in integer arithmetic. The prices are Decimal(78,0) columns and a
  // float divide here would be the one place money passes through a double.
  const changeBps = ((currentPrice - then) * 10_000n) / then;

  return {
    // eslint-disable-next-line no-restricted-syntax -- bps is a ratio for display, bounded below
    changeBps: Number(changeBps > 10_000_000n ? 10_000_000n : changeBps),
    changeWindowHours: hoursAgo,
  };
}

/**
 * How the change tile is labelled and worded.
 *
 * Pure, and exported, so the naming rule is testable without a database — the rule is
 * the part worth protecting. The window is named by the hours actually measured: when
 * this was built the aggregates held fifteen hours in total, so labelling every
 * comparison "24H" would have been wrong for every token on the site.
 */
export function describeChange(
  change: PriceChange,
): { label: string; value: string; tone: "up" | "down" } | null {
  if (change.changeBps === null) return null;
  const hours = change.changeWindowHours ?? PREFERRED_WINDOW_HOURS;
  const percent = change.changeBps / 100;
  return {
    label: `${hours}H change`,
    // An explicit sign on both directions, so a gain is never mistaken for a level.
    value: `${change.changeBps >= 0 ? "+" : ""}${percent.toFixed(1)}%`,
    tone: change.changeBps >= 0 ? "up" : "down",
  };
}

/** Moderation states that must never reach the site's most prominent placement. */
const SUPPRESSED = new Set(["HIDDEN", "FLAGGED"]);

export async function officialToken(): Promise<OfficialToken | null> {
  const address = process.env.NEXT_PUBLIC_OFFICIAL_TOKEN?.trim();
  if (address === undefined || address === "") return null;

  try {
    const token = await tokenDetail(address);
    if (token === null) return null;
    if (SUPPRESSED.has(token.moderationStatus)) return null;
    const stats = await priceChange(token.id, token.price);
    return { ...token, ...stats, card: serialiseToken(token) };
  } catch {
    // The rest of the page has its own queries and is still worth rendering.
    return null;
  }
}
