import { tracesTableCols } from "@langfuse/shared";
import type { FilterConfig } from "@/src/features/filters/lib/filter-config";

import { i18nKey } from "@/src/features/i18n/i18nKey";
export const traceFilterConfig: FilterConfig = {
  tableName: "traces",

  columnDefinitions: tracesTableCols,

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
