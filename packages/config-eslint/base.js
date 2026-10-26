import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import turboConfig from "eslint-config-turbo/flat";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import "eslint-plugin-only-warn";

// Table-split guard (Stage 0.7): inside the
// query-building layer the two per-project logical tables must never appear as
// a bare telemetry table in any read/write SQL clause — it has to be
// routed through tableFor(projectId, "...") so a split project reads its own
// physical table, or through the named sharedTableFor("...") escape hatch for a
// deliberate cross-project shared read. An interpolated `${tableFor(...)}`
// splits the template into separate elements so the raw table token never
// appears in one; only genuinely un-migrated clauses trip the rule.
//
// The clause must sit at the START of a line (optionally behind a JOIN-type
// keyword) — this is how every real multi-line SQL clause here is written, and
// it excludes design-comment prose like `-- read from spans` where the
// keyword falls mid-sentence (or behind a `--`). Case-insensitive (some queries
// lower-case their SQL). `\b` after the name means physical `spans_<pid>`
// names never match.
const TABLE_CLAUSE_RE =
  "(?:\\n|^)\\s*(?!--)[^\\n]*?\\b(?:(?:LEFT|RIGHT|INNER|OUTER|CROSS|FULL)\\s+)*(?:FROM|JOIN|DELETE\\s+FROM|UPDATE|INSERT\\s+INTO)\\s+(?:spans|traces_scalar|observations)\\b";
const TABLE_ROUTING_MESSAGE =
  "Bare spans/traces_scalar/observations in SQL is not split-safe. Use tableFor for one project or the authoritative cross-project target executor.";
const tableRoutingSelectors = [
  {
    selector: `TemplateElement[value.raw=/${TABLE_CLAUSE_RE}/i]`,
    message: TABLE_ROUTING_MESSAGE,
  },
  {
    selector: `Literal[value=/${TABLE_CLAUSE_RE}/i]`,
    message: TABLE_ROUTING_MESSAGE,
  },
];

/**
 * A flat-config block that enforces the table-routing rule on the given file
 * globs (the caller passes globs relative to its own package root, since each
 * package runs eslint from its own cwd).
 *
 * @param {string[]} files - eslint file globs the rule applies to
 */
export const tableRoutingRule = (files) => ({
  name: "langfuse/doris-table-routing",
  files,
  ignores: ["**/*test*.*"],
  rules: {
    "no-restricted-syntax": ["error", ...tableRoutingSelectors],
  },
});

export default tseslint.config(
  // Global ignores
  {
    name: "langfuse/ignores",
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/build/",
      "**/coverage/",
      "**/.next/",
      "**/.*",
      "eslint.config.mjs",
    ],
  },

  // Base JS rules (same as eslint v8 library.js)
  js.configs.recommended,

  // Turbo monorepo rules
  ...turboConfig,

  // Prettier (last for rule precedence)
  eslintPluginPrettierRecommended,

  // Global settings
  {
    name: "langfuse/base/globals",
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2021,
        React: "readonly",
        JSX: "readonly",
      },
    },
    rules: {
      "no-redeclare": "off",
      "import/order": "off",
    },
  },

  // TypeScript-specific - parser only + custom rules
  // Note: Old library.js had no TS rules, only eslint:recommended
  // Adding parser + plugin to support custom rules, but not extending recommended
  {
    name: "langfuse/base/typescript",
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      "no-undef": "off", // TypeScript handles this
      "no-dupe-class-members": "off", // TypeScript handles this (and supports overloads)
      "no-unused-vars": "off", // Use @typescript-eslint/no-unused-vars instead
      "no-restricted-globals": [
        "error",
        {
          name: "redis",
          message: "Import redis explicitly from '@langfuse/shared/src/server'",
        },
      ],
      // Custom rule from eslint v8 shared/.eslintrc.js
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
