import { sessionsViewCols } from "@langfuse/shared";
import type { FilterConfig } from "@/src/features/filters/lib/filter-config";
import type { ColumnToBackendKeyMap } from "@/src/features/filters/lib/filter-transform";

import { i18nKey } from "@/src/features/i18n/i18nKey";
/**
 * Maps frontend column IDs to backend-expected column IDs
 * Frontend uses "tags" but backend CH mapping expects "traceTags" for trace tags on sessions table
 */
export const SESSION_COLUMN_TO_BACKEND_KEY: ColumnToBackendKeyMap = {
  tags: "traceTags",
};

export const sessionFilterConfig: FilterConfig = {
  tableName: "sessions",

  columnDefinitions: sessionsViewCols,

  defaultExpanded: ["environment", "bookmarked"],

  facets: [
    {
      type: "categorical" as const,
      column: "environment",
      label: i18nKey("Environment"),
    },
    {
      type: "string" as const,
      column: "id",
      label: i18nKey("Session ID"),
    },
    {
      type: "categorical" as const,
      column: "userIds",
      label: i18nKey("User IDs"),
    },
    {
      type: "categorical" as const,
      column: "tags",
      label: i18nKey("Trace Tags"),
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
      column: "sessionDuration",
      label: i18nKey("Session Duration"),
      min: 0,
      max: 3600,
      unit: "s",
    },
    {
      type: "numeric" as const,
      column: "countTraces",
      label: i18nKey("Traces Count"),
      min: 0,
      max: 1000,
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
  ],
};
