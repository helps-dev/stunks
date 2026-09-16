/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
