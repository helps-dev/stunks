import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Two of these rules are not style preferences. They encode invariants that the
 * Phase 0 audit proved matter:
 *
 *  - float bans: the verified Pons quote math reproduces on-chain results exactly
 *    at wei precision, and that property is destroyed by a single float conversion.
 *  - address-literal ban: Pons's own published source drifted out of sync with its
 *    deployment. Addresses must be resolved on-chain from one configured input,
 *    never copy-pasted around the codebase.
 */

const MONEY_FLOAT_BAN = [
  {
    selector: "CallExpression[callee.name=/^(Number|parseFloat|parseInt)$/]",
    message:
      "Do not convert financial values through floats. Use bigint and the helpers in @stunks/utils. If this value is provably not money (e.g. a block count for display), add an eslint-disable with a one-line reason.",
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message:
      "Math.random() must never appear in quoting, pricing, or slippage logic. Quotes come from on-chain state or eth_call simulation.",
  },
];

const ADDRESS_LITERAL_BAN = [
  {
    selector: "Literal[value=/^0x[a-fA-F0-9]{40}$/]",
    message:
      "Hardcoded contract addresses belong in @stunks/config only. Everything else resolves addresses on-chain from the configured factory address.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.turbo/**",
      "packages/database/generated/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "no-restricted-syntax": ["error", ...MONEY_FLOAT_BAN, ...ADDRESS_LITERAL_BAN],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },

  // @stunks/config is the one place allowed to name an address.
  {
    files: ["packages/config/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...MONEY_FLOAT_BAN],
    },
  },

  // Tests assert against verified on-chain vectors, which include real addresses,
  // and format numbers for readable failure output.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
);
