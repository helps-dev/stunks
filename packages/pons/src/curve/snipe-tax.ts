/**
 * Anti-snipe tax.
 *
 * This subsystem is deployed but absent from Pons's published source. Its shape was
 * established two independent ways during the audit, which is the only reason it is
 * modelled here at all:
 *
 * 1. Measured by archive simulation, holding the sender constant and varying only
 *    the recipient, so the ratio isolates the tax:
 *
 *      age 0 s  ~98.94%   age 1 s  6.20%   age 2 s  0.19%   age 3 s  0%
 *
 * 2. Third-party documentation states the formula as a bit shift, which reproduces
 *    those measurements exactly:
 *
 *      snipeTaxBps = snipeTaxStartBps >> floor(elapsed * 14 / snipeTaxSeconds)
 *
 * 14 shifts is used because 2^14 = 16384 exceeds the 9900 bps start, so the tax
 * genuinely reaches zero inside the window instead of being cut off while still
 * material.
 *
 * IMPORTANT: the curve exposes `currentSnipeTaxBps(recipient)` on-chain. That is
 * the authoritative source and is what the client reads. The local implementation
 * below exists for previews, tests, and explaining the decay in the UI — not as a
 * substitute.
 */

const SHIFT_STEPS = 14n;

/**
 * Local reimplementation of the decay. Prefer `currentSnipeTaxBps(recipient)`.
 *
 * @param elapsedSeconds seconds since the curve's `launchedAt`
 */
export function computeSnipeTaxBps(args: {
  startBps: bigint;
  windowSeconds: bigint;
  elapsedSeconds: bigint;
  recipientExempt: boolean;
}): bigint {
  const { startBps, windowSeconds, elapsedSeconds, recipientExempt } = args;

  // The exemption is checked against the RECIPIENT, not the sender. Verified by
  // four-way simulation: a non-exempt wallet paying for an exempt recipient pays
  // no tax, while an exempt wallet paying for a non-exempt recipient does.
  if (recipientExempt) return 0n;

  if (windowSeconds <= 0n) return 0n;
  if (elapsedSeconds < 0n) return startBps;
  if (elapsedSeconds >= windowSeconds) return 0n;

  const shift = (elapsedSeconds * SHIFT_STEPS) / windowSeconds;
  if (shift >= 256n) return 0n;
  return startBps >> shift;
}

/** True while a launch is still inside its anti-snipe window. */
export function isWithinSnipeWindow(args: {
  launchedAt: bigint;
  windowSeconds: bigint;
  nowSeconds: bigint;
}): boolean {
  const elapsed = args.nowSeconds - args.launchedAt;
  return elapsed >= 0n && elapsed < args.windowSeconds;
}

/**
 * Whether a quote may use the fast local-math path.
 *
 * Inside the snipe window the answer is always no: the decay formula is
 * corroborated but not read from verified source, and being wrong here means
 * misreporting a trade by up to ~100x. Simulation is cheap; being wrong is not.
 */
export function requiresSimulation(args: {
  launchedAt: bigint;
  windowSeconds: bigint;
  nowSeconds: bigint;
  recipientExempt: boolean;
}): boolean {
  if (args.recipientExempt) return false;
  return isWithinSnipeWindow(args);
}

/**
 * The decay schedule, second by second, for showing users what the tax does.
 * Returns one entry per whole second of the window plus its closing zero.
 */
export function snipeTaxSchedule(startBps: bigint, windowSeconds: bigint) {
  const schedule: { elapsedSeconds: bigint; taxBps: bigint }[] = [];
  for (let second = 0n; second <= windowSeconds; second++) {
    schedule.push({
      elapsedSeconds: second,
      taxBps: computeSnipeTaxBps({
        startBps,
        windowSeconds,
        elapsedSeconds: second,
        recipientExempt: false,
      }),
    });
  }
  return schedule;
}
