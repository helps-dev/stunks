/**
 * Security headers, defined here rather than at the front door.
 *
 * They were only in deploy/Caddyfile, which assumes the app is served behind Caddy on
 * the same VPS as the indexer. It is not always: hosting the app on Vercel puts no
 * Caddy in the request path, and the app would have shipped with no CSP, no
 * X-Frame-Options and no Referrer-Policy at all.
 *
 * Defining them in the app means they travel with it wherever it runs. The Caddyfile
 * no longer repeats them — two CSP headers are intersected by the browser, which is a
 * confusing way to discover that one of them was wrong.
 *
 * The threat is specific. This page constructs the transactions a wallet is asked to
 * sign. Script that should not be running — arriving through a compromised dependency,
 * or anything that reaches the DOM — can rewrite the `to`, `data` and `value`, and the
 * wallet will faithfully present whatever it is handed. The CSP is what stops such
 * script loading from somewhere else or exfiltrating to it.
 */
function securityHeaders() {
  const isDev = process.env.NODE_ENV !== "production";
  // connect-src is derived from the SAME variable the wallet client reads, so an
  // endpoint added to one cannot be silently missing from the other. Getting this
  // wrong fails in the browser with nothing but a console message.
  const rpcOrigins = (process.env.NEXT_PUBLIC_RPC_ENDPOINTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        return null;
      }
    })
    .filter((origin) => origin !== null);

  const csp = [
    "default-src 'self'",
    // 'unsafe-inline' is required by the App Router, which emits inline bootstrap and
    // streaming-payload scripts. Removing it needs nonces threaded through middleware,
    // which is worth doing and is not free.
    //
    // 'unsafe-eval' in DEVELOPMENT ONLY. Next's dev bundler evaluates module code as
    // strings, so without it the client bundle throws
    //
    //   EvalError: Evaluating a string as JavaScript violates the following
    //   Content Security Policy directive: "script-src 'self' 'unsafe-inline'"
    //
    // React then never hydrates and every button on the site is inert — which is how
    // this was found: a wallet picker that would not open. The production bundle does
    // not use eval, so the directive stays strict where it matters.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${rpcOrigins.join(" ")}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      /**
       * `same-origin-allow-popups`, not `same-origin`.
       *
       * Wallets sign in a popup and talk back to the page that opened it. Under strict
       * `same-origin` that channel is severed, and the Coinbase Wallet SDK says so
       * outright in the console:
       *
       *   Coinbase Wallet SDK requires the Cross-Origin-Opener-Policy header to not be
       *   set to 'same-origin'.
       *
       * This variant keeps the protection that matters here — a cross-origin document
       * that opens THIS page still gets no handle on it — while letting popups this
       * page opens keep theirs. It is the value the popup-based auth and wallet flows
       * are designed around.
       */
      key: "Cross-Origin-Opener-Policy",
      value: "same-origin-allow-popups",
    },
    {
      // Nothing here needs a camera, a microphone, a location or a payment handler.
      key: "Permissions-Policy",
      value:
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    },
    {
      // Harmless over plain HTTP in local development; browsers ignore it there.
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    },
  ];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
  // Workspace packages ship TypeScript source rather than a build artefact, so Next
  // has to transpile them. This keeps the packages free of a build step.
  transpilePackages: [
    "@stunks/config",
    "@stunks/database",
    "@stunks/pons",
    "@stunks/types",
    "@stunks/utils",
    "@stunks/web3",
  ],
  experimental: {
    // The approved STUNKS visual assets live at the monorepo root. Static importing
    // them keeps images versioned with the project and avoids an external image host.
    externalDir: true,
  },
  webpack: (config) => {
    // The workspace packages use ESM-style ".js" specifiers that actually point at
    // ".ts" sources. tsc resolves those; webpack needs to be told.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
