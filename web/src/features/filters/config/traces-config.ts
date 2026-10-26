import { tracesTableCols } from "@langfuse/shared";
import type { FilterConfig } from "@/src/features/filters/lib/filter-config";

import { i18nKey } from "@/src/features/i18n/i18nKey";
// LITEFUSE ADDITION — columns that our own deep links put into `/traces?filter=`:
//
// The evaluators v2 "last 5 runs" marker
// (fns/evaluators/evaluatorScoresUrl.ts) navigates to /project/<id>/traces with
// an encoded filter of `traceName`, `environment` and `isRootObservation`.
// `environment` is a traces column and worked; the others were silently dropped
// by `decodeAndNormalizeFilters` ("Unknown filter column skipped"), so the link
// landed on an unfiltered traces list. What each id needs:
//
//   * `traceName` — genuinely supported by the traces query: the shared Doris
//     mapping has `uiTableId: "traceName"` → `t.trace_name`, an explicit alias of
//     `name` added so evals filters work on the traces table
//     (packages/shared/src/server/tableMappings/mapTracesTable.ts). Aliasing it
//     onto this surface's own `name` column ("Trace Name" facet) keeps the
//     applied filter visible in the sidebar and resolves to the same column.
//
//   * `isRootObservation` — intentionally NOT applied here. The traces list is
//     already root-only by construction (`AND t.is_root = 1`,
//     packages/shared/src/server/services/traces-ui-table-service.ts), and the
//     traces query has no mapping for this id, so forwarding it would make the
//     Doris filter builder throw
//     (`matchAndVerifyTracesUiColumn`, queries/doris-sql/factory.ts) instead of
//     filtering. Declared below so the drop is explicit and readable.
//
//   * `ruleId` — no longer emitted by our links: the rules table's "View traces"
//     now forwards the rule's OWN filter (fns/rules/ruleLinkUrls.ts), which is
//     the traces the rule evaluates. The id is kept declared because older
//     bookmarked URLs still carry it, and it was never a traces column anyway
//     (the rule id only lives in score metadata / `job_configuration_id` spans).
//     Supporting it for real would need a backend column mapping, i.e. a shared
//     change. Note the rules link also narrows the rule's observation-level
//     filter down to the conditions this surface can apply *before* encoding it,
//     so no rule condition reaches this config as an unknown column.
export const traceFilterConfig: FilterConfig = {
  tableName: "traces",

  columnDefinitions: tracesTableCols,

  columnAliases: {
    traceName: "name",
  },

  unappliedFilterColumns: {
    isRootObservation:
      "the traces list already shows one row per trace, so it is always the root span",
    ruleId:
      "filtering traces by evaluation rule is not supported by the traces query yet",
  },

  defaultExpanded: ["environment", "name"],

  facets: [
    {
      type: "categorical" as const,
      column: "environment",
      label: i18nKey("Environment"),
    },
    {
      type: "categorical" as const,
      column: "name",
      label: i18nKey("Trace Name"),
    },
    {
      type: "string" as const,
      column: "id",
      label: i18nKey("Trace ID"),
    },
    {
      type: "categorical" as const,
      column: "userId",
      label: i18nKey("User ID"),
    },
    {
      type: "categorical" as const,
      column: "sessionId",
      label: i18nKey("Session ID"),
    },
    {
      type: "stringKeyValue" as const,
      column: "metadata",
      label: i18nKey("Metadata"),
    },
    {
      type: "string" as const,
      column: "version",
      label: i18nKey("Version"),
    },
    {
      type: "string" as const,
      column: "release",
      label: i18nKey("Release"),
    },
    {
      type: "boolean" as const,
      column: "bookmarked",
      label: i18nKey("Bookmarked"),
      trueLabel: "Bookmarked",
      falseLabel: "Not bookmarked",
    },
    {
      type: "numeric" as const,
      column: "commentCount",
      label: i18nKey("Comment Count"),
      min: 0,
      max: 100,
    },
    {
      type: "string" as const,
      column: "commentContent",
      label: i18nKey("Comment Content"),
    },
    {
      type: "categorical" as const,
      column: "tags",
      label: i18nKey("Tags"),
    },
    {
      type: "categorical" as const,
      column: "level",
      label: i18nKey("Level"),
    },
    {
      type: "numeric" as const,
      column: "latency",
      label: i18nKey("Latency"),
      min: 0,
      max: 60,
      unit: "s",
    },
    {
      type: "numeric" as const,
      column: "inputTokens",
      label: i18nKey("Input Tokens"),
      min: 0,
      max: 1000000,
    },
    {
      type: "numeric" as const,
      column: "outputTokens",
      label: i18nKey("Output Tokens"),
      min: 0,
      max: 1000000,
    },
    {
      type: "numeric" as const,
      column: "totalTokens",
      label: i18nKey("Total Tokens"),
      min: 0,
      max: 1000000,
    },
    {
      type: "numeric" as const,
      column: "inputCost",
      label: i18nKey("Input Cost"),
      min: 0,
      max: 100,
      unit: "$",
    },
    {
      type: "numeric" as const,
      column: "outputCost",
      label: i18nKey("Output Cost"),
      min: 0,
      max: 100,
      unit: "$",
    },
    {
      type: "numeric" as const,
      column: "totalCost",
      label: i18nKey("Total Cost"),
      min: 0,
      max: 100,
      unit: "$",
    },
    {
      type: "keyValue" as const,
      column: "score_categories",
      label: i18nKey("Categorical Scores"),
    },
    {
      type: "numericKeyValue" as const,
      column: "scores_avg",
      label: i18nKey("Numeric Scores"),
    },
  ],
};
