import { describe, expect, it, vi } from "vitest";
import type { Repositories } from "@stunks/database";
import type { RpcPool } from "@stunks/web3";
import { buildHealthSnapshot } from "./health.js";

/**
 * The gap this reports is not lag, and the difference is the whole point.
 *
 * Lag is above the checkpoint and closes on its own. A gap BELOW the checkpoint never
 * closes, because `advance` refuses to move backwards — so an index missing 37M blocks
 * of launches looked identical to a healthy one that happened to be near the head.
 *
 * Observed 2026-09-17: configured start 26,841,846, factory checkpoint 65,231,377,
 * earliest indexed launch 63,775,021, TokenLaunched events on-chain down to at least
 * block 40,000,000 — and this endpoint reported `ok`.
 */
function deps(
  streams: { stream: string; lastProcessedBlock: bigint }[],
  startBlock: bigint,
): Parameters<typeof buildHealthSnapshot>[0] {
  return {
    chainId: 4663,
    startBlock,
    chainHead: () => Promise.resolve(65_231_400n),
    pool: { stats: () => [] } as unknown as RpcPool,
    repos: {
      checkpoints: {
        health: vi.fn().mockResolvedValue({
          unresolvedFailedBlocks: 0,
          streams: streams.map((s) => ({
            ...s,
            lastSuccessAt: new Date("2026-09-17T00:00:00Z"),
            lastError: null,
            isPaused: false,
            logWindowSize: 100,
          })),
        }),
      },
    } as unknown as Repositories,
  };
}

describe("health: unscanned history", () => {
  it("is degraded when the factory checkpoint starts above the configured block", async () => {
    const snapshot = await buildHealthSnapshot(
      deps(
        [
          { stream: "factory", lastProcessedBlock: 65_231_377n },
          { stream: "curves", lastProcessedBlock: 64_309_721n },
        ],
        26_841_846n,
      ),
    );

    expect(snapshot.hasUnscannedHistory).toBe(true);
    expect(snapshot.status).toBe("degraded");
    const factory = snapshot.streams.find((s) => s.stream === "factory");
    expect(factory?.unscannedBelow).toBe(String(65_231_377n - 26_841_846n));
  });

  it("is ok when the factory checkpoint sits at the configured start block", async () => {
    const snapshot = await buildHealthSnapshot(
      deps(
        [
          { stream: "factory", lastProcessedBlock: 26_841_846n },
          { stream: "curves", lastProcessedBlock: 26_841_846n },
        ],
        26_841_846n,
      ),
    );

    expect(snapshot.hasUnscannedHistory).toBe(false);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.streams[0]?.unscannedBelow).toBeNull();
  });

  it("does not flag the curve stream, which is fast-forwarded on purpose", async () => {
    // The curve stream legitimately skips history before the earliest launch: a curve
    // cannot emit a trade before it is deployed.
    const snapshot = await buildHealthSnapshot(
      deps(
        [
          { stream: "factory", lastProcessedBlock: 26_841_846n },
          { stream: "curves", lastProcessedBlock: 63_775_020n },
        ],
        26_841_846n,
      ),
    );

    expect(snapshot.hasUnscannedHistory).toBe(false);
    expect(snapshot.status).toBe("ok");
    // Still reported per stream, so the skip is visible even though it is expected.
    const curves = snapshot.streams.find((s) => s.stream === "curves");
    expect(curves?.unscannedBelow).not.toBeNull();
  });

  it("keeps being behind the head separate from having a hole below it", async () => {
    const snapshot = await buildHealthSnapshot(
      deps([{ stream: "factory", lastProcessedBlock: 26_841_846n }], 26_841_846n),
    );
    const factory = snapshot.streams[0];
    // Far behind the head, but nothing was skipped.
    expect(BigInt(factory!.lagBlocks!)).toBeGreaterThan(38_000_000n);
    expect(factory?.unscannedBelow).toBeNull();
    expect(snapshot.status).toBe("ok");
  });
});
