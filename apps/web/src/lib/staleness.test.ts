import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_SECONDS,
  summariseStaleness,
  type StreamState,
} from "./staleness.js";

/**
 * The regression these tests exist for.
 *
 * On 2026-09-17 the factory stream sat 361 blocks behind the head while the curve
 * stream was 715,288 blocks behind — about twenty hours. The banner reported the
 * factory figure, so the page claimed to be 37 seconds current while every price on
 * it was a day old.
 */
const HEAD = 64_838_719n;

function stream(name: string, block: bigint, isPaused = false): StreamState {
  return {
    stream: name,
    lastProcessedBlock: block,
    lastSuccessAt: new Date("2026-09-17T00:00:00.000Z"),
    isPaused,
  };
}

describe("summariseStaleness", () => {
  it("reports the slowest stream, not the fastest", () => {
    const result = summariseStaleness(
      [stream("factory", 64_838_719n), stream("curves", 64_123_792n)],
      HEAD,
    );

    expect(result.stream).toBe("curves");
    expect(result.indexedBlock).toBe("64123792");
    expect(result.lagBlocks).toBe("714927");
    expect(result.isStale).toBe(true);
  });

  it("does not care which order the streams arrive in", () => {
    const ordered = summariseStaleness(
      [stream("factory", 64_838_719n), stream("curves", 64_123_792n)],
      HEAD,
    );
    const reversed = summariseStaleness(
      [stream("curves", 64_123_792n), stream("factory", 64_838_719n)],
      HEAD,
    );
    expect(reversed.stream).toBe(ordered.stream);
    expect(reversed.lagBlocks).toBe(ordered.lagBlocks);
  });

  it("is current only when every required stream is close to the head", () => {
    const result = summariseStaleness(
      [stream("factory", HEAD - 100n), stream("curves", HEAD - 200n)],
      HEAD,
    );
    expect(result.isStale).toBe(false);
    expect(result.stream).toBe("curves");
  });

  it("treats a paused stream as stale even when its block number looks fine", () => {
    const result = summariseStaleness(
      [stream("factory", HEAD), stream("curves", HEAD, true)],
      HEAD,
    );
    expect(result.lagSeconds).toBe(0);
    expect(result.isStale).toBe(true);
  });

  it("reports unknown rather than current when a required stream is missing", () => {
    const result = summariseStaleness([stream("factory", HEAD)], HEAD);
    expect(result.stream).toBeNull();
    expect(result.indexedBlock).toBeNull();
    expect(result.lagBlocks).toBeNull();
    expect(result.isStale).toBe(true);
    expect(result.streams).toEqual([]);
  });

  it("reports unknown rather than zero lag when the chain head is unavailable", () => {
    const result = summariseStaleness(
      [stream("factory", HEAD), stream("curves", HEAD)],
      null,
    );
    expect(result.lagBlocks).toBeNull();
    expect(result.lagSeconds).toBeNull();
    expect(result.isStale).toBe(true);
  });

  it("clamps rather than reporting a negative lag when a stream is past the head", () => {
    const result = summariseStaleness(
      [stream("factory", HEAD + 50n), stream("curves", HEAD + 10n)],
      HEAD,
    );
    expect(result.lagBlocks).toBe("0");
    expect(result.lagSeconds).toBe(0);
    expect(result.isStale).toBe(false);
  });

  it("carries every required stream so a page can show where the backlog is", () => {
    const result = summariseStaleness(
      [stream("factory", 64_838_719n), stream("curves", 64_123_792n)],
      HEAD,
    );
    expect(result.streams.map((entry) => entry.stream)).toEqual(["factory", "curves"]);
    expect(result.streams[0]?.lagBlocks).toBe("0");
    expect(result.streams[1]?.lagBlocks).toBe("714927");
  });

  it("uses the documented staleness boundary", () => {
    // ~9.87 blocks/second, so the boundary is a little under 6,000 blocks.
    const justInside = BigInt(Math.floor((STALE_AFTER_SECONDS - 10) / 0.1013));
    const justOutside = BigInt(Math.ceil((STALE_AFTER_SECONDS + 10) / 0.1013));

    expect(
      summariseStaleness(
        [stream("factory", HEAD), stream("curves", HEAD - justInside)],
        HEAD,
      ).isStale,
    ).toBe(false);

    expect(
      summariseStaleness(
        [stream("factory", HEAD), stream("curves", HEAD - justOutside)],
        HEAD,
      ).isStale,
    ).toBe(true);
  });
});
