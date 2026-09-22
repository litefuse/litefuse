import { defineConfig } from "i18next-cli";

/**
 * Keys are the English source strings, so:
 *  - `en.json` is a generated inventory (key === value) and is not bundled;
 *  - `zh-CN.json` is the dictionary bundled by src/features/i18n/instance.ts.
 *
 * `pnpm i18n:extract` syncs both from the code. `pnpm i18n:check` fails when
 * the files are stale or zh-CN has an empty/missing value. `pnpm i18n:lint`
 * lists hardcoded strings still to migrate (the rollout gate for zh-CN).
 */
export default defineConfig({
  locales: ["en", "zh-CN"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    ignore: [
      "src/**/*.clienttest.*",
      "src/**/*.servertest.*",
      "src/__tests__/**",
      "src/__e2e__/**",
      // Deprecated vendored subtree, see README.
      "src/features/discover/**",
      "src/lib/discover-shims/**",
    ],
    output: "src/features/i18n/locales/{{language}}.json",
    defaultNS: false,
    keySeparator: false,
    nsSeparator: false,
    functions: ["t", "*.t", "i18nKey"],
    primaryLanguage: "en",
    secondaryLanguages: ["zh-CN"],
    removeUnusedKeys: true,
    sort: true,
  },
  lint: {
    ignore: ["src/features/discover/**", "src/lib/discover-shims/**"],
  },
});
