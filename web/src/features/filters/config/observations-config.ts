import { observationsTableCols } from "@langfuse/shared";
import type { FilterConfig } from "@/src/features/filters/lib/filter-config";
import type { ColumnToBackendKeyMap } from "@/src/features/filters/lib/filter-transform";
import { renderFilterIcon } from "@/src/components/ItemBadge";

import { i18nKey } from "@/src/features/i18n/i18nKey";
/**
 * Maps frontend column IDs to backend-expected column IDs
 * Frontend uses "tags" but backend CH mapping expects "traceTags" for trace tags on observations table
 */
export const OBSERVATION_COLUMN_TO_BACKEND_KEY: ColumnToBackendKeyMap = {
  tags: "traceTags",
};

export const observationFilterConfig: FilterConfig = {
  tableName: "observations",

  columnDefinitions: observationsTableCols,

  defaultExpanded: ["environment", "name"],

  facets: [
    {
      type: "categorical" as const,
      column: "environment",
      label: i18nKey("Environment"),
    },
    {
      type: "categorical" as const,
      column: "type",
      label: i18nKey("Type"),
      renderIcon: renderFilterIcon,
    },
    {
      type: "categorical" as const,
      column: "name",
      label: i18nKey("Name"),
    },
    {
      type: "categorical" as const,
      column: "traceName",
      label: i18nKey("Trace Name"),
    },
    {
      type: "categorical" as const,
      column: "level",
      label: i18nKey("Level"),
    },
    {
      type: "categorical" as const,
      column: "model",
      label: i18nKey("Model"),
    },
    {
      type: "categorical" as const,
      column: "modelId",
      label: i18nKey("Model ID"),
    },
    {
      type: "categorical" as const,
      column: "promptName",
      label: i18nKey("Prompt Name"),
    },
    {
      type: "categorical" as const,
      column: "tags",
      label: i18nKey("Trace Tags"),
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
      type: "numeric" as const,
      column: "latency",
      label: i18nKey("Latency"),
      min: 0,
      max: 60,
      unit: "s",
    },
    {
      type: "numeric" as const,
      column: "timeToFirstToken",
      label: i18nKey("Time to First Token"),
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
      type: "categorical" as const,
      column: "toolNames",
      label: i18nKey("Tool Names (Available)"),
    },
    {
      type: "categorical" as const,
      column: "calledToolNames",
      label: i18nKey("Tool Names (Called)"),
    },
    {
      type: "numeric" as const,
      column: "toolDefinitions",
      label: i18nKey("Available Tools"),
      min: 0,
      max: 25,
    },
    {
      type: "numeric" as const,
      column: "toolCalls",
      label: i18nKey("Tool Calls"),
      min: 0,
      max: 25,
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
