import { eventsTableCols } from "@langfuse/shared";
import type { FilterConfig } from "@/src/features/filters/lib/filter-config";
import type { ColumnToBackendKeyMap } from "@/src/features/filters/lib/filter-transform";
import { renderFilterIcon } from "@/src/components/ItemBadge";

import { i18nKey } from "@/src/features/i18n/i18nKey";
// Helper function to get column name from eventsTableCols by ID
export const getEventsColumnName = (id: string): string => {
  const column = eventsTableCols.find((col) => col.id === id);
  if (!column) {
    throw new Error(`Column ${id} not found in eventsTableCols`);
  }
  return column?.name;
};

/**
 * Maps frontend column IDs to backend-expected column IDs for events table
 * Events table uses different naming conventions than observations table
 */
export const OBSERVATION_EVENTS_COLUMN_TO_BACKEND_KEY: ColumnToBackendKeyMap = {
  // No mapping needed currently - events table column names align with UI
};

export const observationEventsFilterConfig: FilterConfig = {
  tableName: "observations-events",

  columnDefinitions: eventsTableCols,

  defaultExpanded: ["environment", "name", "hasParentObservation", "type"],

  facets: [
    {
      type: "categorical" as const,
      column: "environment",
      label: getEventsColumnName("environment"),
    },
    {
      type: "categorical" as const,
      column: "type",
      label: getEventsColumnName("type"),
      renderIcon: renderFilterIcon,
    },
    {
      type: "boolean" as const,
      column: "hasParentObservation",
      label: i18nKey("Is Root Observation"),
      tooltip: i18nKey(
        "A root observation is the top-level observation in a trace. It has no parent observation ID. Filter to 'True' to see only root-level observations.",
      ),
      invertValue: true, // "True" = hasParentObservation=false (is root)
    },
    {
      type: "categorical" as const,
      column: "traceName",
      label: getEventsColumnName("traceName"),
    },
    {
      type: "categorical" as const,
      column: "name",
      label: getEventsColumnName("name"),
    },
    {
      type: "categorical" as const,
      column: "level",
      label: getEventsColumnName("level"),
    },
    {
      type: "positionInTrace" as const,
      column: "positionInTrace",
      label: getEventsColumnName("positionInTrace"),
      mutuallyExclusiveWith: [
        "score_categories",
        "scores_avg",
        "trace_score_categories",
        "trace_scores_avg",
      ],
    },
    {
      type: "categorical" as const,
      column: "providedModelName",
      label: getEventsColumnName("providedModelName"),
    },
    {
      type: "categorical" as const,
      column: "modelId",
      label: getEventsColumnName("modelId"),
    },
    {
      type: "categorical" as const,
      column: "promptName",
      label: getEventsColumnName("promptName"),
    },
    {
      type: "categorical" as const,
      column: "traceTags",
      label: getEventsColumnName("traceTags"),
    },
    {
      type: "stringKeyValue" as const,
      column: "metadata",
      label: getEventsColumnName("metadata"),
    },
    {
      type: "categorical" as const,
      column: "version",
      label: getEventsColumnName("version"),
    },
    {
      type: "string" as const,
      column: "statusMessage",
      label: getEventsColumnName("statusMessage"),
    },
    {
      type: "string" as const,
      column: "traceId",
      label: getEventsColumnName("traceId"),
    },
    {
      type: "categorical" as const,
      column: "sessionId",
      label: getEventsColumnName("sessionId"),
    },
    {
      type: "categorical" as const,
      column: "userId",
      label: getEventsColumnName("userId"),
    },
    {
      type: "categorical" as const,
      column: "experimentDatasetId",
      label: getEventsColumnName("experimentDatasetId"),
    },
    {
      type: "categorical" as const,
      column: "experimentId",
      label: getEventsColumnName("experimentId"),
    },
    {
      type: "categorical" as const,
      column: "experimentName",
      label: getEventsColumnName("experimentName"),
    },
    {
      type: "numeric" as const,
      column: "latency",
      label: getEventsColumnName("latency"),
      min: 0,
      max: 60,
      unit: "s",
    },
    {
      type: "numeric" as const,
      column: "timeToFirstToken",
      label: getEventsColumnName("timeToFirstToken"),
      min: 0,
      max: 60,
      unit: "s",
    },
    {
      type: "numeric" as const,
      column: "inputTokens",
      label: getEventsColumnName("inputTokens"),
      min: 0,
      max: 1000000,
    },
    {
      type: "numeric" as const,
      column: "outputTokens",
      label: getEventsColumnName("outputTokens"),
      min: 0,
      max: 1000000,
    },
    {
      type: "numeric" as const,
      column: "totalTokens",
      label: getEventsColumnName("totalTokens"),
      min: 0,
      max: 1000000,
    },
    {
      type: "numeric" as const,
      column: "inputCost",
      label: getEventsColumnName("inputCost"),
      min: 0,
      max: 100,
      unit: "$",
    },
    {
      type: "numeric" as const,
      column: "outputCost",
      label: getEventsColumnName("outputCost"),
      min: 0,
      max: 100,
      unit: "$",
    },
    {
      type: "numeric" as const,
      column: "totalCost",
      label: getEventsColumnName("totalCost"),
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
      type: "keyValue" as const,
      column: "trace_score_categories",
      label: i18nKey("Trace Categorical Scores"),
    },
    {
      type: "numericKeyValue" as const,
      column: "trace_scores_avg",
      label: i18nKey("Trace Numeric Scores"),
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
