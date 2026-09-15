import { describe, expect, it } from "vitest";
import {
  computeSnipeTaxBps,
  isWithinSnipeWindow,
  requiresSimulation,
  snipeTaxSchedule,
} from "./snipe-tax.js";

/**
 * The decay was established twice, independently, and the two agree:
 *
 *   measured by archive simulation:  ~98.94% / 6.20% / 0.19% / 0%  at 0/1/2/3 s
 *   documented bit shift:            9900 >> floor(elapsed * 14 / windowSeconds)
 *
 * These tests pin the formula against the live parameters (start 9900, window 3).
 */

const LIVE = { startBps: 9_900n, windowSeconds: 3n } as const;

describe("decay schedule against live parameters", () => {
  const expected: [bigint, bigint][] = [
    [0n, 9_900n], // 99.00%  — shift 0
    [1n, 618n], //  6.18%  — shift 4
    [2n, 19n], //  0.19%  — shift 9
    [3n, 0n], //  0.00%  — window closed
    [4n, 0n],
  ];

  for (const [elapsed, bps] of expected) {
    it(`is ${bps} bps at ${elapsed}s`, () => {
      expect(
        computeSnipeTaxBps({ ...LIVE, elapsedSeconds: elapsed, recipientExempt: false }),
      ).toBe(bps);
    });
  }

  it("collapses almost entirely within the first second", () => {
    const atZero = computeSnipeTaxBps({
      ...LIVE,
      elapsedSeconds: 0n,
      recipientExempt: false,
    });
    const atOne = computeSnipeTaxBps({
      ...LIVE,
      elapsedSeconds: 1n,
      recipientExempt: false,
    });
    // The product claim must be "a launch-block advantage", not "3 seconds of
    // protection". This assertion is what keeps that honest.
    expect(atOne * 15n).toBeLessThan(atZero);
  });
});

describe("exemption is keyed on the recipient", () => {
  it("returns zero for an exempt recipient even at age zero", () => {
    expect(
      computeSnipeTaxBps({ ...LIVE, elapsedSeconds: 0n, recipientExempt: true }),
    ).toBe(0n);
  });

  it("returns the full start rate for a non-exempt recipient at age zero", () => {
    expect(
      computeSnipeTaxBps({ ...LIVE, elapsedSeconds: 0n, recipientExempt: false }),
    ).toBe(LIVE.startBps);
  });
});

describe("edge cases", () => {
  it("treats a zero-length window as no tax", () => {
    expect(
      computeSnipeTaxBps({
        startBps: 9_900n,
        windowSeconds: 0n,
        elapsedSeconds: 0n,
        recipientExempt: false,
      }),
    ).toBe(0n);
  });

  it("treats a negative elapsed time as the start rate, not as expired", () => {
    // Clock skew between an RPC block timestamp and local time must never make a
    // fresh launch look safe.
    expect(
      computeSnipeTaxBps({ ...LIVE, elapsedSeconds: -5n, recipientExempt: false }),
    ).toBe(LIVE.startBps);
  });
});

describe("window membership", () => {
  it("is inclusive of the launch second and exclusive of the closing second", () => {
    expect(
      isWithinSnipeWindow({ launchedAt: 100n, windowSeconds: 3n, nowSeconds: 100n }),
    ).toBe(true);
    expect(
      isWithinSnipeWindow({ launchedAt: 100n, windowSeconds: 3n, nowSeconds: 102n }),
    ).toBe(true);
    expect(
      isWithinSnipeWindow({ launchedAt: 100n, windowSeconds: 3n, nowSeconds: 103n }),
    ).toBe(false);
  });
});

describe("simulation policy", () => {
  it("requires simulation for a non-exempt recipient inside the window", () => {
    expect(
      requiresSimulation({
        launchedAt: 100n,
        windowSeconds: 3n,
        nowSeconds: 101n,
        recipientExempt: false,
      }),
    ).toBe(true);
  });

  it("allows local math once the window has closed", () => {
    expect(
      requiresSimulation({
        launchedAt: 100n,
        windowSeconds: 3n,
        nowSeconds: 103n,
        recipientExempt: false,
      }),
    ).toBe(false);
  });

  it("allows local math for an exempt recipient at any time", () => {
    expect(
      requiresSimulation({
        launchedAt: 100n,
        windowSeconds: 3n,
        nowSeconds: 100n,
        recipientExempt: true,
      }),
    ).toBe(false);
  });
});

describe("schedule for UI display", () => {
  it("covers every whole second including the closing zero", () => {
    const schedule = snipeTaxSchedule(LIVE.startBps, LIVE.windowSeconds);
    expect(schedule).toHaveLength(4);
    expect(schedule.at(0)?.taxBps).toBe(9_900n);
    expect(schedule.at(-1)?.taxBps).toBe(0n);
  });
});
