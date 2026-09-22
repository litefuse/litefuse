import { i18nKey } from "./i18nKey";

/**
 * Filter column names declared in `packages/shared/src/tableDefinitions`.
 *
 * That package is shared with the worker and cannot import from the web app,
 * so its column names stay plain strings there and are translated where they
 * render (the filter builder calls `t(column.name)`). This inventory exists so
 * `i18next-cli extract` keeps those keys: the extractor only sees `i18nKey()`
 * calls, and `removeUnusedKeys` would otherwise drop them on the next run.
 *
 * Regenerate after adding a column:
 *   grep -h -oE '\bname: "[^"]+"' packages/shared/src/tableDefinitions/*.ts \
 *     | sed 's/name: //' | sort -u
 */
export const SHARED_TABLE_COLUMN_NAMES = [
  i18nKey("Comment Content"),
  i18nKey("Comment Count"),
  i18nKey("Config"),
  i18nKey("Created At"),
  i18nKey("Data Type"),
  i18nKey("Dataset"),
  i18nKey("Debug Level Count"),
  i18nKey("Default Level Count"),
  i18nKey("Environment"),
  i18nKey("Error Level Count"),
  i18nKey("ID"),
  i18nKey("Input Cost ($)"),
  i18nKey("Input Tokens"),
  i18nKey("Labels"),
  i18nKey("Latency (s)"),
  i18nKey("Level"),
  i18nKey("Metadata"),
  i18nKey("Name"),
  i18nKey("Observation ID"),
  i18nKey("Output Cost ($)"),
  i18nKey("Output Tokens"),
  i18nKey("Release"),
  i18nKey("Scores (categorical)"),
  i18nKey("Scores (numeric)"),
  i18nKey("Session Duration (s)"),
  i18nKey("Session ID"),
  i18nKey("Source"),
  i18nKey("String Value"),
  i18nKey("Tags"),
  i18nKey("Timestamp"),
  i18nKey("Tokens"),
  i18nKey("Total Cost ($)"),
  i18nKey("Total Tokens"),
  i18nKey("Trace ID"),
  i18nKey("Trace Name"),
  i18nKey("Trace Tags"),
  i18nKey("Traces Count"),
  i18nKey("Type"),
  i18nKey("Updated At"),
  i18nKey("Usage"),
  i18nKey("User ID"),
  i18nKey("User IDs"),
  i18nKey("Value"),
  i18nKey("Version"),
  i18nKey("Warning Level Count"),
] as const;
