import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { MAX_DECLARABLE_SNIPE_EXEMPTIONS } from "@stunks/config";
import { EXEMPTION_DISCLOSURES, validateSnipeExemptions } from "./exemptions.js";

/**
 * The 31 limit here is not copied from documentation. It was measured by
 * simulating `launchAndBuy` against the live router: 31 declared addresses is
 * accepted, 32 reverts (`pnpm probe:exemptions`).
 *
 * These tests exist because the on-chain check happens only after the launch fee is
 * committed, so client-side enforcement is what actually protects the creator.
 */

const DEPLOYER = "0x7d3a7e460425f0b407174608670889377c41e9bc" as Address;
const RECIPIENT = "0x914b7c99ea1b90d858d3cc94a029233386e42be1" as Address;

function addresses(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
  );
}

describe("verified limit", () => {
  it("agrees with the measured on-chain boundary", () => {
    expect(MAX_DECLARABLE_SNIPE_EXEMPTIONS).toBe(31);
  });

  it("accepts exactly 31 addresses", () => {
    const result = validateSnipeExemptions({
      addresses: addresses(31),
      deployer: DEPLOYER,
    });
    expect(result.errors).toEqual([]);
    expect(result.slotsUsed).toBe(31);
    expect(result.slotsRemaining).toBe(0);
  });

  it("rejects 32 before the user can sign, and says why it matters", () => {
    const result = validateSnipeExemptions({
      addresses: addresses(32),
      deployer: DEPLOYER,
    });
    expect(result.errors).toHaveLength(1);
    // The message must explain the cost, not just state a number.
    expect(result.errors[0]).toMatch(/at most 31/i);
    expect(result.errors[0]).toMatch(/after the launch fee is taken/i);
  });

  it("tells the user how many to remove", () => {
    const result = validateSnipeExemptions({
      addresses: addresses(35),
      deployer: DEPLOYER,
    });
    expect(result.errors[0]).toMatch(/Remove 4 address/i);
  });
});

describe("normalisation", () => {
  it("checksums addresses and reports remaining slots", () => {
    const result = validateSnipeExemptions({
      addresses: [RECIPIENT],
      deployer: DEPLOYER,
    });
    expect(result.errors).toEqual([]);
    expect(result.addresses).toHaveLength(1);
    // Output is EIP-55 checksummed, not the lowercase input.
    expect(result.addresses[0]).not.toBe(RECIPIENT);
    expect(result.addresses[0]?.toLowerCase()).toBe(RECIPIENT);
    expect(result.slotsRemaining).toBe(30);
  });

  it("ignores blank entries so a trailing empty form row is harmless", () => {
    const result = validateSnipeExemptions({
      addresses: ["", "   ", RECIPIENT],
      deployer: DEPLOYER,
    });
    expect(result.errors).toEqual([]);
    expect(result.slotsUsed).toBe(1);
  });

  it("removes duplicates and warns, rather than silently wasting a slot", () => {
    const result = validateSnipeExemptions({
      addresses: [RECIPIENT, RECIPIENT],
      deployer: DEPLOYER,
    });
    expect(result.errors).toEqual([]);
    expect(result.slotsUsed).toBe(1);
    expect(result.warnings[0]).toMatch(/more than once/i);
  });

  it("frees the slot when the deployer whitelists itself unnecessarily", () => {
    // The factory exempts the launching wallet automatically.
    const result = validateSnipeExemptions({
      addresses: [DEPLOYER, RECIPIENT],
      deployer: DEPLOYER,
    });
    expect(result.slotsUsed).toBe(1);
    expect(result.warnings[0]).toMatch(/exempted automatically/i);
  });

  it("also frees the slot for a distinct creator fee recipient", () => {
    const result = validateSnipeExemptions({
      addresses: [RECIPIENT],
      deployer: DEPLOYER,
      creatorFeeRecipient: RECIPIENT,
    });
    expect(result.slotsUsed).toBe(0);
    expect(result.warnings).toHaveLength(1);
  });

  it("lets a 32nd entry through once auto-exempt duplicates are removed", () => {
    // 31 real addresses plus the deployer, which needs no slot.
    const result = validateSnipeExemptions({
      addresses: [...addresses(31), DEPLOYER],
      deployer: DEPLOYER,
    });
    expect(result.errors).toEqual([]);
    expect(result.slotsUsed).toBe(31);
  });
});

describe("rejections", () => {
  it("rejects a malformed address with its position", () => {
    const result = validateSnipeExemptions({
      addresses: [RECIPIENT, "0xnope"],
      deployer: DEPLOYER,
    });
    expect(result.errors[0]).toMatch(/Entry 2 is not a valid address/i);
  });

  it("rejects the zero address, which cannot receive tokens", () => {
    const result = validateSnipeExemptions({
      addresses: ["0x0000000000000000000000000000000000000000"],
      deployer: DEPLOYER,
    });
    expect(result.errors[0]).toMatch(/zero address/i);
  });
});

describe("disclosures", () => {
  it("states the permanence, the publicity, and the brevity of the advantage", () => {
    const text = EXEMPTION_DISCLOSURES.join(" ");
    expect(text).toMatch(/no way to add an address afterwards/i);
    expect(text).toMatch(/stored publicly on-chain/i);
    expect(text).toMatch(/cannot be hidden/i);
    // Overclaiming the window is the failure mode this copy guards against.
    expect(text).toMatch(/brief/i);
  });
});
