import tsParser from "@typescript-eslint/parser";

import { i18nRuleBlock } from "./eslint.i18n.rules.mjs";

/** A rule that never reports: only its existence matters. */
const noop = { create: () => ({}) };

/**
 * Standalone config for the i18n gate.
 *
 * The shared repo config imports `eslint-plugin-only-warn`, which rewrites
 * every rule's severity to "warning" — so `eslint src` exits 0 no matter how
 * many i18n violations exist, and "the gate is green" carries no signal. This
 * config loads the same rule block without that plugin, so the rules keep the
 * "error" severity they are declared with.
 *
 * Run it through `pnpm i18n:gate`.
 */
export default [
  {
    // The source carries `eslint-disable` comments for rules this config does
    // not enable. ESLint errors on an unknown rule name in a disable comment,
    // so the plugins are registered here with every rule left off.
    name: "litefuse/web/i18n-gate-known-rules",
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: {
      "@typescript-eslint": { rules: { "no-unused-vars": noop } },
      "@next/next": { rules: { "no-img-element": noop } },
      "react-hooks": { rules: { "exhaustive-deps": noop } },
    },
  },
  {
    ...i18nRuleBlock,
    name: "litefuse/web/i18n-gate",
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
];
