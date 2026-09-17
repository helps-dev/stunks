import { describe, expect, it } from "vitest";
import { isDatabaseAvailabilityError } from "./client.js";

describe("isDatabaseAvailabilityError", () => {
  it.each(["P1001", "P1017", "P2024"])("recognises retryable Prisma code %s", (code) => {
    expect(isDatabaseAvailabilityError({ code })).toBe(true);
  });

  it("recognises Neon pool and reachability messages even when wrapped by Prisma", () => {
    expect(
      isDatabaseAvailabilityError(
        new Error("Can't reach database server at pooled.neon.tech:5432"),
      ),
    ).toBe(true);
    expect(
      isDatabaseAvailabilityError(
        new Error("Timed out fetching a new connection from the connection pool"),
      ),
    ).toBe(true);
  });

  it("does not hide a data or query error as a temporary outage", () => {
    expect(
      isDatabaseAvailabilityError(new Error("invalid input syntax for numeric")),
    ).toBe(false);
  });
});
