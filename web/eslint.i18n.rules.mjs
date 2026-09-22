import i18next from "eslint-plugin-i18next";

// Shared by eslint.config.mjs (editor feedback) and eslint.i18n.config.mjs
// (the gate). This module must never import the repo eslint config: that
// chain loads eslint-plugin-only-warn, which rewrites every severity to
// "warning" and would make the gate unable to fail.
// Deprecated, and a vendored subtree that may be re-synced wholesale, so it is
// never translated and never enters the gate.
export const I18N_EXCLUDED_FILES = [
  "**/*.clienttest.tsx",
  "**/*.servertest.tsx",
  "src/features/discover/**",
  "src/lib/discover-shims/**",
  // Error reporting stays English by decision: this toast prints the server's
  // own message verbatim, so translating the heading around it would produce a
  // Chinese title over an English body. See the README.
  "src/utils/trpcErrorToast.tsx",
];

// Every component file, plus the non-component modules that hold user-facing
// text as data: filter configs, the widget data model, survey content and the
// zod schemas whose messages a form renders. The exclusions above are the only
// exemptions, and zh-CN goes live once the gates are clean across all of them.
export const I18N_MIGRATED_FILES = [
  "src/**/*.tsx",
  "src/features/filters/config/*.ts",
  "src/features/events/config/*.ts",
  "src/features/query/dataModel*.ts",
  "src/features/score-analytics/lib/statistics-utils.ts",
  "src/features/dashboard/lib/score-analytics-utils.ts",
  "src/features/navigation/utils/*.ts",
  "src/features/onboarding/lib/questions.ts",
  "src/features/auth/lib/signupSchema.ts",
  "src/features/blobstorage-integration/types.ts",
  "src/features/models/validation.ts",
  "src/features/support-chat/formConstants.ts",
  "src/utils/date-range-utils.ts",
];

export const i18nRuleBlock = {
  name: "litefuse/web/i18n-no-literal-string",
  files: I18N_MIGRATED_FILES,
  ignores: I18N_EXCLUDED_FILES,
  plugins: { i18next },
  rules: {
    // The JSX rule cannot see text that travels as data before it is
    // rendered: column headers, option labels, tooltip copy. Those live on a
    // small set of property names, so guard them by name.
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "Property[key.name=/^(header|label|title|description|placeholder|tooltip|message|emptyMessage|heading|helpText|text|required|confirmText|targetLabel|buttonText|emptyText|searchPlaceholder|noResultsMessage|setUpMessage|oldLabel|newLabel|tabTitle|errorMessage|subtitle|question|hint|caption|summary|note)$/] > Literal[value=/^(?=.*[A-Z ])[A-Za-z][A-Za-z0-9 ,.()'!?:;&%$#@*+=\\x2F-]*$/]",
        message:
          "User-facing text in a data property must be an i18n key: wrap it with i18nKey() and translate it where it is rendered.",
      },
      {
        // Toast copy is a call argument, which no JSX rule can see, and it is
        // some of the most visible text in the app.
        selector:
          "CallExpression[callee.name=/^(showErrorToast|showSuccessToast)$/] Literal[value=/^(?=.*[a-z])(?=.*[A-Z ])[A-Za-z][A-Za-z0-9 ,.()'!?:;&%$#@*+=\\x2F-]*$/]:not(CallExpression[callee.name=/^(t|i18nKey|translate)$/] > *)",
        message:
          "Toast text must go through t(). Pass the translated string, not the English literal.",
      },
      {
        selector:
          "CallExpression[callee.object.name='toast'] Literal[value=/^(?=.*[a-z])(?=.*[A-Z ])[A-Za-z][A-Za-z0-9 ,.()'!?:;&%$#@*+=\\x2F-]*$/]:not(CallExpression[callee.name=/^(t|i18nKey|translate)$/] > *)",
        message:
          "Toast text must go through t(). Pass the translated string, not the English literal.",
      },
      {
        // A native dialog is still UI, and its copy is invisible to every
        // other rule here.
        selector:
          "CallExpression[callee.name=/^(alert|confirm|prompt)$/] > :matches(Literal, TemplateLiteral)",
        message: "Native dialog copy must go through t().",
      },
      {
        // The i18next rule runs in jsx-text-only mode, so attribute values are
        // covered here instead. Naming the attributes explicitly keeps the
        // enum-valued props (variant, side, col, context, ...) out, without
        // the subtree-skipping that an allowlist inside the plugin causes.
        selector:
          "JSXAttribute[name.name=/^(title|placeholder|label|description|tooltip|alt|aria-label|heading|helpText|text|confirmText|targetLabel|buttonText|emptyText|searchPlaceholder|noResultsMessage|setUpMessage|oldLabel|newLabel|message|errorMessage|subtitle|caption|hint)$/] > Literal[value=/^(?=.*[A-Z ])[A-Za-z][A-Za-z0-9 ,.()'!?:;&%$#@*+=\\x2F-]*$/]",
        message: "User-facing text in a JSX attribute must go through t().",
      },
    ],
    "i18next/no-literal-string": [
      "error",
      {
        // jsx-text-only: only literals whose direct parent is a JSX element
        // are reported. Attribute values and the call arguments, arrays and
        // object literals inside handler expressions are covered by the
        // selectors above instead, which judge them far more precisely.
        mode: "jsx-text-only",
        // Replaces the plugin defaults, so they are restated here. The last
        // two entries let symbols and key caps through while still flagging
        // hardcoded Chinese, which has appeared in this codebase before.
        words: {
          exclude: [
            "[0-9!-/:-@[-`{-~]+",
            "[A-Z_-]+",
            "[^A-Za-z\\u4e00-\\u9fff]+",
            "(Ctrl|Cmd|Alt|Shift|Esc|Backspace)(\\+\\w+)?",
          ],
        },
        // Literals handed to these calls are field names, format strings and
        // ids, never text. Restates the plugin defaults, which this replaces.
        callees: {
          exclude: [
            "i18n(ext)?",
            "t",
            "require",
            "addEventListener",
            "removeEventListener",
            "postMessage",
            "getElementById",
            "dispatch",
            "commit",
            "includes",
            "indexOf",
            "endsWith",
            "startsWith",
            "watch",
            "getValues",
            "setValue",
            "resetField",
            "register",
            "trigger",
            "clearErrors",
            "setError",
            "getFieldState",
            "format",
            "formatDate",
            "parse",
            "get",
            "set",
            "has",
            "capture",
            "push",
            "replace",
            "prefetch",
            "setQueryParam",
            // Event handlers inside JSX attributes are now visible to the
            // rule, and their arguments are field names, ids and enum values
            // rather than text. Matched in full, so showSuccessToast,
            // showErrorToast, alert and confirm still get checked.
            "(set|update|toggle|handle|track|emit|navigate|goto|select|apply|register|unregister)[A-Z].*",
            ".*\\.(theme|setState|emit|track|capture|send)",
            "cva",
            "cn",
            "clsx",
            "twMerge",
          ],
        },
        // A denylist, deliberately: with an `include` allowlist the plugin
        // skips every other attribute together with its entire JSX subtree,
        // which exempted every react-hook-form `render={...}` body in the
        // app. Only attributes that never carry human-readable text belong
        // here.
        // A denylist rather than an allowlist, for the same reason as
        // jsx-attributes: an allowlist would skip the JSX nested inside any
        // other property. Text-bearing keys stay checked here and are also
        // guarded by the no-restricted-syntax rule above.
        "object-properties": {
          exclude: [
            "href",
            "url",
            "src",
            "to",
            "type",
            "id",
            "key",
            "value",
            "name",
            "path",
            "pathname",
            "source",
            "action",
            "scope",
            "status",
            "level",
            "severity",
            "variant",
            "size",
            "mode",
            "step",
            "format",
            "column",
            "operator",
            "dataType",
            "objectType",
            "field",
            "accessorKey",
            "queryKey",
            "event",
            "method",
            "target",
            "rel",
            "role",
            "icon",
            "color",
            "className",
            "testId",
            "slug",
            "kind",
            "tag",
            "code",
            "locale",
            "currency",
            "provider",
            "adapter",
            "model",
            "unit",
            "sql",
            "alias",
            "relationTable",
            "chartType",
            "aggregation",
            ".*(Key|Id|Type|Mode|Url|Href|Path|Class|Variant|Field|Column)",
          ],
        },
        "jsx-attributes": {
          exclude: [
            "className",
            "class",
            "classNames",
            "key",
            "id",
            "htmlFor",
            "href",
            "src",
            "to",
            "type",
            "name",
            "role",
            "rel",
            "target",
            "style",
            "value",
            "defaultValue",
            "variant",
            "size",
            "side",
            "align",
            "position",
            "mode",
            "scope",
            "slug",
            "path",
            "pathname",
            "testId",
            // Typed literal unions and data keys: the typechecker rejects a
            // t() call in these positions, so flagging them is pure noise.
            "dataKey",
            "interval",
            "analyticsEventName",
            "currentView",
            "columnIdentifier",
            "source",
            "direction",
            "orientation",
            "layout",
            "collapsible",
            "collapsedSize",
            "minSize",
            "defaultSize",
            "level",
            "severity",
            "status",
            "state",
            "paramKey",
            "tableName",
            // Component props that name a thing rather than say something.
            ".*(Variant|Key|Type|Mode|Id|Direction|Align|Side|Size|Color|Icon|Format|Field|Column|Scope|Action|Step)",
            "step",
            "maxHeight",
            "minHeight",
            "draggableHandle",
            "localStorageSuffix",
            "data-.*",
            "aria-hidden",
            "autoComplete",
            "inputMode",
            "accept",
            "method",
            "encType",
            "dir",
            "lang",
            "width",
            "height",
            "fill",
            "stroke",
            "viewBox",
            "d",
            "xmlns",
          ],
        },
      },
    ],
  },
};
