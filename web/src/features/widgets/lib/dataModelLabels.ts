import startCase from "lodash/startCase";

import { i18nKey } from "@/src/features/i18n/i18nKey";

/**
 * Labels for the widget data model.
 *
 * Measure and dimension keys are query identifiers, so the form used to run
 * `startCase` over them to get a label. That produced English no matter the
 * locale, which is why every key in `src/features/query/dataModel.ts` gets an
 * entry here instead; `dataModelLabelKey` falls back to the old behaviour for
 * anything added later.
 *
 * Regenerate the candidate list from the `measures` and `dimensions` blocks of
 * `src/features/query/dataModel.ts`.
 */
const DATA_MODEL_LABELS: Record<string, string> = {
  aggs: i18nKey("Aggs"),
  calledToolNames: i18nKey("Called Tool Names"),
  costByType: i18nKey("Cost By Type"),
  costType: i18nKey("Cost Type"),
  count: i18nKey("Count"),
  countScores: i18nKey("Count Scores"),
  environment: i18nKey("Environment"),
  filterSql: i18nKey("Filter Sql"),
  id: i18nKey("Id"),
  inputCost: i18nKey("Input Cost"),
  inputTokens: i18nKey("Input Tokens"),
  latency: i18nKey("Latency"),
  level: i18nKey("Level"),
  name: i18nKey("Name"),
  observationsCount: i18nKey("Observations Count"),
  outputCost: i18nKey("Output Cost"),
  outputTokens: i18nKey("Output Tokens"),
  outputTokensPerSecond: i18nKey("Output Tokens Per Second"),
  pairExpand: i18nKey("Pair Expand"),
  parentObservationId: i18nKey("Parent Observation Id"),
  promptName: i18nKey("Prompt Name"),
  promptVersion: i18nKey("Prompt Version"),
  providedModelName: i18nKey("Provided Model Name"),
  release: i18nKey("Release"),
  scoresCount: i18nKey("Scores Count"),
  sessionId: i18nKey("Session Id"),
  startTimeMonth: i18nKey("Start Time Month"),
  streamingLatency: i18nKey("Streaming Latency"),
  stringValue: i18nKey("String Value"),
  tags: i18nKey("Tags"),
  timeToFirstToken: i18nKey("Time To First Token"),
  timestampMonth: i18nKey("Timestamp Month"),
  tokensPerSecond: i18nKey("Tokens Per Second"),
  toolCalls: i18nKey("Tool Calls"),
  toolDefinitions: i18nKey("Tool Definitions"),
  toolNames: i18nKey("Tool Names"),
  totalCost: i18nKey("Total Cost"),
  totalTokens: i18nKey("Total Tokens"),
  traceId: i18nKey("Trace Id"),
  traceName: i18nKey("Trace Name"),
  traceRelease: i18nKey("Trace Release"),
  traceVersion: i18nKey("Trace Version"),
  type: i18nKey("Type"),
  uniqueSessionIds: i18nKey("Unique Session Ids"),
  uniqueUserIds: i18nKey("Unique User Ids"),
  usageByType: i18nKey("Usage By Type"),
  usageType: i18nKey("Usage Type"),
  userId: i18nKey("User Id"),
  value: i18nKey("Value"),
  version: i18nKey("Version"),
};

/**
 * Aggregations offered next to a measure. The percentiles read the same in
 * every locale, so they are plain strings: `t()` returns them unchanged and no
 * dictionary entry that looks like an identifier is created.
 */
const AGGREGATION_LABELS: Record<string, string> = {
  sum: i18nKey("Sum"),
  avg: i18nKey("Avg"),
  count: i18nKey("Count"),
  max: i18nKey("Max"),
  min: i18nKey("Min"),
  p50: "P50",
  p75: "P75",
  p90: "P90",
  p95: "P95",
  p99: "P99",
  histogram: i18nKey("Histogram"),
  uniq: i18nKey("Unique"),
};

/** The i18n key for a measure or dimension, or its start-cased name. */
export function dataModelLabelKey(key: string): string {
  return DATA_MODEL_LABELS[key] ?? startCase(key);
}

/** The i18n key for an aggregation, or its start-cased name. */
export function aggregationLabelKey(aggregation: string): string {
  return (
    AGGREGATION_LABELS[aggregation.toLowerCase()] ?? startCase(aggregation)
  );
}
