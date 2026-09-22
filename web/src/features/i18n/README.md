# UI internationalization

react-i18next with **English source strings as keys**. English never goes
through a dictionary: a missing translation renders the key, so upstream
merges that add English text can never break the UI or block a release.

## Writing UI text

```tsx
const { t } = useTranslation();
<Button>{t("Create new project")}</Button>
<Input placeholder={t("Search {{entity}}", { entity: t("prompts") })} />
```

- Static data (route tables, label maps) cannot call hooks: wrap the literal
  with `i18nKey("Tracing")` and let the rendering component call `t(value)`.
- Never wrap identifiers the SDKs, OTel or the API read (attribute names,
  enum values, column ids). Only text a person reads is a key. Translating one
  breaks ingestion silently, so `locales.clienttest.ts` rejects any key that
  reads like a machine identifier; do not add to its allowlist to get past it
  without checking what reads the string.
- Do not build sentences by concatenation; use one key with placeholders.
- Translate against [GLOSSARY.md](./GLOSSARY.md) and add any new recurring
  term to it in the same commit. Term drift across hundreds of files is the
  main quality risk of this migration.

## Locale resolution

`account preference (users.locale)` > `NEXT_LOCALE cookie` > `Accept-Language`

> `en`, restricted to `LITEFUSE_I18N_LOCALES` (server env, comma separated,
> default `en,zh-CN`; set `en` for an English-only deployment). The server
> resolves cookie/header in `_app` / `_document`
> (`getI18nAppProps.ts`); the provider re-syncs to the account preference once
> the session is loaded. URLs never carry a locale prefix.

The language switcher (`LanguageSwitcher`, account settings, sign-in page)
renders only when more than one locale is enabled, which is how an
English-only deployment hides it.

## Tooling (`web/`)

| Command             | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `pnpm i18n:extract` | Sync `locales/en.json` (inventory) and `locales/zh-CN.json` from code   |
| `pnpm i18n:check`   | CI: fails if locale files are stale or zh-CN has an empty/missing value |
| `pnpm i18n:lint`    | Lists hardcoded strings still to migrate                                |

`eslint.config.mjs` (`I18N_MIGRATED_FILES`) turns hardcoded JSX strings into
lint failures. It covers every `.tsx` file plus the non-component modules that
carry user-facing text as data: filter configs, the widget data model, survey
content and the zod schemas whose messages a form renders. Add a new file of
that kind to the list in the same commit that introduces it.

Client tests initialise the default i18next instance through
`src/__tests__/i18n-client-setup.ts`, so `t()` interpolates in tests exactly as
it does for an English user and assertions read the English copy.

`locales.clienttest.ts` additionally checks that both locale files hold the
same keys, that no zh-CN value is empty, that keys are the English text, that
interpolation placeholders survive translation, and that no key looks like a
protocol identifier.

## Not translated

**Error reporting stays English.** `TRPCError` messages raised under
`src/server` and the feature routers are printed verbatim by the global error
toast, so `src/utils/trpcErrorToast.tsx` keeps its titles and descriptions in
English too: a translated heading over an untranslated body is the mixed state
this migration exists to avoid. The file is in `I18N_EXCLUDED_FILES` so the
gate does not ask for it back.

This applies to text that _is_ an error. It does not apply to a toast whose
title describes what the user was doing, e.g.
`showErrorToast(t("Failed to update dashboard"), error.message)`: the heading
is UI copy and stays translated, the body is the raw server message and stays
English.

`src/features/discover/**` (and its shims) is deprecated and vendored, and may
be re-synced wholesale, so it is excluded from both lint gates and from
extraction. It stays English regardless of the selected language. Nothing else
in `src/` is exempt.

## Gate

`pnpm i18n:gate` is the real check. `pnpm run lint` cannot be one: the repo
eslint config loads `eslint-plugin-only-warn`, which rewrites every severity to
"warning", so `eslint src` exits 0 no matter how many violations exist. The
gate runs the same rules through `eslint.i18n.config.mjs`, which imports
`eslint.i18n.rules.mjs` directly and never touches that plugin. Keep it that
way: the moment the rules module imports the repo config, the gate stops being
able to fail.

The rules and why they are shaped that way:

- `i18next/no-literal-string` runs in **`jsx-text-only`** mode, so it reports
  only literals rendered directly as JSX children. Everything else it could see
  (call arguments, object literals, arrays inside event handlers) holds
  identifiers far more often than text, and judging those by value shape
  produced hundreds of false positives.
- `jsx-attributes` must stay an **exclude** denylist even so. With an `include`
  allowlist the plugin skips every other attribute _together with its whole JSX
  subtree_, which exempted every react-hook-form `render={...}` body in the app.
- Attribute values, data properties, toast copy and native dialog copy each get
  an explicit `no-restricted-syntax` selector. Naming the attributes and
  property keys keeps enum-valued props (`variant`, `col`, `context`,
  `severity`) out without re-introducing the subtree skipping.

Still outside every rule, and so still a human's job: text returned from a
helper function and text built with a template literal. (Server error messages
are the third such category, and they stay English by decision; see **Not
translated**.) Measure the first of those with:

```sh
grep -rnoE '\breturn\s+"[^"]{6,}"' src --include='*.ts*' | grep -vE 'discover|test'
```

and the second with:

```sh
grep -rnE '(text|title|description|label|header|placeholder|tooltip):\s*`[^`]*[a-z]{3,} [a-z]{2,}' \
  src --include='*.ts*' | grep -vE 'discover|test|/server/|/routers/'
```

Four more shapes the rules cannot see, each of which produced defects:

- a literal used as a fallback inside a JSX expression, `{name || "Untitled"}`;
- a label derived from a query identifier or an API enum with `startCase`,
  `capitalize` or a hand-rolled split — the widget data model, table columns
  and status facets were all built this way;
- a value that is both a label and a discriminator (a panel title, a maintainer
  badge, a score-column prefix). Translating it at its source breaks the
  comparison, so it stays English and is translated at the render site;
- a default value a form writes into the database, e.g. the generated
  experiment or widget name.

## Checking the rendered page

The cheapest end-to-end check is to read the DOM of a running page and list the
visible text that is entirely Latin. Run this in the browser console on each
page (it has no false negatives for chrome, and its false positives are the
user's own data):

```js
(() => {
  const skip = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA"]);
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode()); ) {
    const p = n.parentElement;
    if (!p || skip.has(p.tagName) || !p.offsetParent) continue;
    const t = n.textContent.trim();
    if (!t || /[\u4e00-\u9fff]/.test(t)) continue;
    if (!/[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(t)) continue;
    out.push(t.slice(0, 90));
  }
  return [...new Set(out)];
})();
```

A page has to be _used_, not just opened: most of the defects this found were
behind a dialog, a second wizard step, or a table that was empty until real
data existed.

## Rollout rule

zh-CN is on by default (`LITEFUSE_I18N_LOCALES=en,zh-CN`) since coverage
reached 100% on 2026-09-22. The bar for keeping it on: no user-visible English
outside the seeded content listed below. A green gate is necessary but not
sufficient: it says no rule-visible literal is left, not that the UI is
translated, so walk the pages after any sizeable merge.

Seeded content is the remaining English a user sees: the built-in evaluator
templates, the managed dashboards and their widgets, the Correctness queue and
the default score configs. Those are rows a project owns and can rename, and
their names are the keys the seeders match on, so they are a product decision
rather than a translation one. The Next.js 404 page is also English; the app
ships no `pages/404.tsx`.

After every upstream merge: `pnpm i18n:extract`, translate the new keys against
the glossary, then `pnpm i18n:check` and `pnpm i18n:gate`.
