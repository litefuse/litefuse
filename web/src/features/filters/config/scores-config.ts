import { scoresTableCols } from "@/src/server/api/definitions/scoresTable";
import type { FilterConfig } from "@/src/features/filters/lib/filter-config";
import type { ColumnToBackendKeyMap } from "@/src/features/filters/lib/filter-transform";

import { i18nKey } from "@/src/features/i18n/i18nKey";
// Maps frontend column IDs to backend-expected column IDs
// Frontend uses "tags" but backend CH mapping expects "trace_tags" for trace tags on scores table
export const SCORE_COLUMN_TO_BACKEND_KEY: ColumnToBackendKeyMap = {
  tags: "trace_tags",
};

export const scoreFilterConfig: FilterConfig = {
  tableName: "scores",

  columnDefinitions: scoresTableCols,

  defaultExpanded: ["environment", "name"],

  defaultSidebarCollapsed: true,

  facets: [
    {
      type: "categorical" as const,
      column: "environment",
      label: i18nKey("Environment"),
    },
    {
      type: "categorical" as const,
      column: "name",
      label: i18nKey("Name"),
    },
    {
      type: "categorical" as const,
      column: "source",
      label: i18nKey("Source"),
    },
    {
      type: "categorical" as const,
      column: "dataType",
      label: i18nKey("Data Type"),
    },
    {
      type: "numeric" as const,
      column: "value",
      label: i18nKey("Value"),
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      type: "categorical" as const,
      column: "stringValue",
      label: i18nKey("String Value"),
    },
    {
      type: "string" as const,
      column: "traceId",
      label: i18nKey("Trace ID"),
    },
    {
      type: "string" as const,
      column: "sessionId",
      label: i18nKey("Session ID"),
    },
    {
      type: "categorical" as const,
      column: "traceName",
      label: i18nKey("Trace Name"),
    },
    {
      type: "string" as const,
      column: "observationId",
      label: i18nKey("Observation ID"),
    },
    {
      type: "categorical" as const,
      column: "userId",
      label: i18nKey("User ID"),
    },
    {
      type: "categorical" as const,
      column: "tags",
      label: i18nKey("Trace Tags"),
    },
  ],
};
