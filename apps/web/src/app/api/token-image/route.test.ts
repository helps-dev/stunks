import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * Tests the real route handler, not a copy of its logic.
 *
 * `fetch` is stubbed so the cases that matter — a redirect to a private address, a
 * content type that is not an image, a body over the cap — can be provoked exactly.
 * Provoking them against real gateways would be unreliable and would not cover the
 * ones no public host would ever produce.
 *
 * The gateway behaviour these tests do NOT cover (which hosts answer, how fast, and
 * with what status) was measured against live gateways instead, because a stub cannot
 * tell you that Pinata takes 4.5 seconds or that 4everland answers 301.
 */

function request(url: string): Request {
  return new Request(`https://stunks.fun/api/token-image?url=${encodeURIComponent(url)}`);
}

/** A response the route should accept. */
function imageResponse(bytes = 32, type = "image/png"): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": type },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token image proxy", () => {
  it("serves an image and marks it non-sniffable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse(64, "image/png")),
    );
    const response = await GET(request("https://img.koyen.fun/a.png"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("never sends a referrer upstream", async () => {
    const fetchSpy = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchSpy);
    await GET(request("https://img.koyen.fun/a.png"));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.referrerPolicy).toBe("no-referrer");
    // Manual, so each hop is re-checked rather than followed by the implementation.
    expect(init.redirect).toBe("manual");
  });

  it("tries the next gateway when one fails, for ipfs", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(imageResponse(16, "image/jpeg"));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await GET(request("ipfs://bafkreiabc"));
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("follows a redirect to another public host", async () => {
    // 4everland answers 301 to its own subdomain gateway. Rejecting 3xx disabled it
    // entirely, which is the bug this covers.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://bafkreiabc.ipfs.4everland.io/" },
        }),
      )
      .mockResolvedValueOnce(imageResponse(16, "image/webp"));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await GET(request("ipfs://bafkreiabc"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
  });

  it("refuses a redirect to a private address", async () => {
    // The URL came from a stranger, so a redirect is an SSRF attempt until proven
    // otherwise. Every hop is re-validated.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          }),
      ),
    );
    const response = await GET(request("https://img.koyen.fun/a.png"));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-image-miss")).toContain("redirect-blocked");
  });

  it("refuses SVG, HTML and anything not on the allowlist", async () => {
    for (const type of ["image/svg+xml", "text/html", "application/octet-stream"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => imageResponse(16, type)),
      );
      const response = await GET(request("https://img.koyen.fun/a.png"));
      expect(response.status, type).toBe(404);
      expect(response.headers.get("x-image-miss")).toContain("type-");
    }
  });

  it("refuses a body over the cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(5 * 1024 * 1024), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    const response = await GET(request("https://img.koyen.fun/big.png"));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-image-miss")).toContain("too-large");
  });

  it("refuses an empty body rather than serving zero bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse(0, "image/png")),
    );
    expect((await GET(request("https://img.koyen.fun/a.png"))).status).toBe(404);
  });

  it("rejects values that are not image references without fetching", async () => {
    const fetchSpy = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchSpy);
    for (const value of [
      "verifying fresh-wallet funding path on pons v2",
      "http://example.com/a.png",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "https://user:pass@example.com/a.png",
    ]) {
      const response = await GET(request(value));
      expect(response.status, value).toBe(404);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s with no url parameter", async () => {
    const response = await GET(new Request("https://stunks.fun/api/token-image"));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-image-miss")).toBe("no-url");
  });

  it("names every gateway's own failure, not just the last", async () => {
    // Reporting only the last reason made a Pinata timeout and a 4everland redirect
    // both look like ipfs.io returning 429.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const response = await GET(request("ipfs://bafkreiabc"));
    const miss = response.headers.get("x-image-miss") ?? "";
    expect(miss).toContain("4everland.io:http-503");
    expect(miss).toContain("gateway.pinata.cloud:http-503");
  });

  it("caches a miss so a dead host is not re-fetched per visitor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const response = await GET(request("https://img.koyen.fun/gone.png"));
    expect(response.headers.get("cache-control")).toContain("max-age=300");
  });
});
