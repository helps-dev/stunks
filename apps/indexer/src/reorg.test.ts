import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  DEFAULT_CONFIRMATION_DEPTH,
  checkForReorg,
  safeHead,
  verifyLineage,
} from "./reorg.js";

const HASH_A =
  "0xaaaa000000000000000000000000000000000000000000000000000000000000" as Hex;
const HASH_B =
  "0xbbbb000000000000000000000000000000000000000000000000000000000000" as Hex;
const HASH_C =
  "0xcccc000000000000000000000000000000000000000000000000000000000000" as Hex;

describe("checkForReorg", () => {
  it("accepts a matching hash", () => {
    expect(
      checkForReorg({ recordedHash: HASH_A, recordedBlock: 1_000n, currentHash: HASH_A }),
    ).toEqual({ kind: "OK" });
  });

  it("ignores hash casing, which differs between endpoints", () => {
    expect(
      checkForReorg({
        recordedHash: HASH_A.toUpperCase().replace("0X", "0x"),
        recordedBlock: 1_000n,
        currentHash: HASH_A,
      }),
    ).toEqual({ kind: "OK" });
  });

  it("detects divergence and rewinds PAST it, not just to it", () => {
    const verdict = checkForReorg(
      { recordedHash: HASH_A, recordedBlock: 1_000n, currentHash: HASH_B },
      12,
    );
    expect(verdict.kind).toBe("REORG");
    if (verdict.kind === "REORG") {
      // The orphaned block's parent may also have been replaced, so rewinding only
      // to the divergence point could leave a trade from a dead history in place.
      expect(verdict.rollbackTo).toBe(988n);
      expect(verdict.recordedHash).toBe(HASH_A);
      expect(verdict.currentHash).toBe(HASH_B);
    }
  });

  it("does not rewind below genesis", () => {
    const verdict = checkForReorg(
      { recordedHash: HASH_A, recordedBlock: 5n, currentHash: HASH_B },
      12,
    );
    expect(verdict.kind).toBe("REORG");
    if (verdict.kind === "REORG") expect(verdict.rollbackTo).toBe(0n);
  });

  it("reports a missing hash as UNVERIFIABLE rather than as OK", () => {
    // This happens on a fresh checkpoint and right after a rollback. Treating it as
    // "no reorg" would hide the one case where we genuinely do not know.
    const verdict = checkForReorg({
      recordedHash: null,
      recordedBlock: 1_000n,
      currentHash: HASH_A,
    });
    expect(verdict.kind).toBe("UNVERIFIABLE");
  });

  it("respects a configured rollback depth", () => {
    const verdict = checkForReorg(
      { recordedHash: HASH_A, recordedBlock: 1_000n, currentHash: HASH_B },
      100,
    );
    if (verdict.kind === "REORG") expect(verdict.rollbackTo).toBe(900n);
  });
});

describe("safeHead", () => {
  it("holds back the confirmation depth", () => {
    expect(safeHead(1_000n, 12)).toBe(988n);
  });

  it("costs about a second at this chain's block time", () => {
    // 12 blocks x ~101 ms. Cheap enough that there is no reason to be aggressive.
    const seconds = DEFAULT_CONFIRMATION_DEPTH * 0.1013;
    expect(seconds).toBeLessThan(2);
  });

  it("returns null rather than zero for a chain younger than the depth", () => {
    // A caller receiving 0n could mistake it for "scan from genesis", which on this
    // chain would be 63 million wasted blocks.
    expect(safeHead(5n, 12)).toBeNull();
    expect(safeHead(12n, 12)).toBeNull();
    expect(safeHead(13n, 12)).toBe(1n);
  });
});

describe("verifyLineage", () => {
  it("accepts an unbroken chain", () => {
    expect(
      verifyLineage([
        { number: 1n, hash: HASH_A, parentHash: HASH_C },
        { number: 2n, hash: HASH_B, parentHash: HASH_A },
      ]),
    ).toEqual({ ok: true });
  });

  it("reports the block where the parent link breaks", () => {
    const result = verifyLineage([
      { number: 1n, hash: HASH_A, parentHash: HASH_C },
      // Parent should be HASH_A: a reorg landed mid-batch.
      { number: 2n, hash: HASH_B, parentHash: HASH_C },
    ]);
    expect(result).toEqual({ ok: false, brokenAt: 2n });
  });

  it("treats a single block and an empty batch as trivially fine", () => {
    expect(verifyLineage([]).ok).toBe(true);
    expect(verifyLineage([{ number: 1n, hash: HASH_A, parentHash: HASH_C }]).ok).toBe(
      true,
    );
  });
});
