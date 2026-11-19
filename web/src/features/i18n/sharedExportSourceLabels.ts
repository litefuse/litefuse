import { i18nKey } from "./i18nKey";

/**
 * Labels and descriptions of the analytics-integration export sources.
 *
 * They are declared in `packages/shared`
 * (`features/analytics-integrations/index.ts`, `EXPORT_SOURCE_OPTIONS`) next
 * to the values the form stores, so they cannot be wrapped at their
 * declaration. The blob storage, Mixpanel and PostHog integration pages
 * translate them at the render site; this inventory is what stops
 * `removeUnusedKeys` from dropping the keys.
 *
 * Regenerate the candidate list with:
 *   grep -nE '(label|description):' \
 *     packages/shared/src/features/analytics-integrations/index.ts
 */
export const SHARED_EXPORT_SOURCE_LABELS = [
  i18nKey("Traces and observations (legacy)"),
  i18nKey(
    "Export traces, observations and scores. This is the legacy behavior prior to tracking traces and observations in separate tables. It is recommended to use the enriched observations option instead.",
  ),
  i18nKey("Traces and observations (legacy) and enriched observations"),
  i18nKey(
    "Export traces, observations, scores and enriched observations. This exports both the legacy data source (traces, observations) and the new one (enriched observations) and essentially exports duplicate data. Therefore, it should only be used to migrate existing integrations to the new recommended enriched observations and check validity of the data for downstream consumers of the export data.",
  ),
  i18nKey("Enriched observations (recommended)"),
  i18nKey(
    "Export enriched observations and scores. This is the recommended data source for integrations and will be the default for new integrations.",
  ),
] as const;
