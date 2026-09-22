import { type ViewDeclarationType } from "./types";
import { tableFor } from "@langfuse/shared/src/server";

import { i18nKey } from "@/src/features/i18n/i18nKey";
// Hybrid model over the spans deployment (migrations 0037/0039/0040):
// - tracesViewDoris reads traces_scalar (one row per trace — the root span's
//   scalar fields, written by the OTel-lane job) for its base and scalar
//   dimensions, and joins a trace_metrics_agg rewrite-shaped aggregate over
//   spans for per-trace metrics.
// - observationsViewDoris stays on spans (every row is an OTel span;
//   one OTel span = one row).
// - scores views join traces_scalar for trace-level dimensions.
//
// traces_scalar stores user_id/session_id/release/version/name as NULL where
// the spans root row holds '' (NULLIF at write). Dimensions COALESCE
// back to '' so grouped outputs and filters keep the upstream non-nullable
// String convention ('' = unset) that the previous spans-based queries
// exposed. COALESCE'd dimension SQL embeds its own table alias — the query
// builder must not prefix expression selects.

// Tokens replaced by the query builder when a tableRelation's `name` is a
// derived table (parenthesized SELECT). Project id and query window are baked
// into the subquery because outer relation time filters cannot apply to it:
// it exposes no raw time column, and rewrite-compatible bounds must live
// inside in day-truncated form.
export const RELATION_SQL_PROJECT_ID = "__RELATION_PROJECT_ID__";
export const RELATION_SQL_FROM_TIMESTAMP = "__RELATION_FROM_TIMESTAMP__";
export const RELATION_SQL_TO_TIMESTAMP = "__RELATION_TO_TIMESTAMP__";

// Per-trace metric aggregate in the trace_metrics_agg sync-MV rewrite shape
// (migration 0040). The sync MV cannot be queried by name: Doris transparently
// rewrites this scan onto the rollup only while every aggregate stays
// expression-identical to the MV definition (SUM/MIN/MAX over the same base
// columns, SUM(CASE WHEN is_root = 0 THEN 1 ELSE 0 END)) and the WHERE only
// references MV key expressions — hence date_trunc(start_time, 'day') bounds,
// not the exact query window (sub-day precision cannot ride the rollup; the
// exact trace-level window is enforced by the base traces_scalar.start_time
// filter). GROUP BY (project_id, trace_id) is a subset of the MV keys; the
// rollup regroups across days.
const traceMetricsAggRelationSql = (projectId: string) => `(
  SELECT
    project_id,
    trace_id,
    MIN(start_time) AS min_start_time,
    MAX(start_time) AS max_start_time,
    MIN(end_time) AS min_end_time,
    MAX(end_time) AS max_end_time,
    SUM(total_tokens_calculated) AS total_tokens,
    SUM(total_cost) AS total_cost,
    SUM(CASE WHEN is_root = 0 THEN 1 ELSE 0 END) AS observation_count
  FROM ${tableFor(projectId, "spans")}
  WHERE project_id = '${RELATION_SQL_PROJECT_ID}'
    AND date_trunc(start_time, 'day') >= date_trunc('${RELATION_SQL_FROM_TIMESTAMP}', 'day')
    AND date_trunc(start_time, 'day') <= date_trunc('${RELATION_SQL_TO_TIMESTAMP}', 'day')
  GROUP BY project_id, trace_id
)`;

export const tracesViewDoris = (projectId: string): ViewDeclarationType => ({
  name: "traces",
  description: i18nKey(
    "Traces represent a group of observations and typically represent a single request or operation.",
  ),
  dimensions: {
    id: {
      sql: "id",
      alias: "id",
      type: "string",
      description: i18nKey("Unique identifier of the trace."),
    },
    name: {
      sql: "coalesce(traces.name, '')",
      alias: "name",
      type: "string",
      description: i18nKey(
        "Name assigned to the trace (often the endpoint or operation).",
      ),
    },
    tags: {
      sql: "tags",
      type: "string[]",
      description: i18nKey("User-defined tags associated with the trace."),
    },
    userId: {
      sql: "coalesce(traces.user_id, '')",
      alias: "userId",
      type: "string",
      description: i18nKey("Identifier of the user triggering the trace."),
    },
    sessionId: {
      sql: "coalesce(traces.session_id, '')",
      alias: "sessionId",
      type: "string",
      description: i18nKey("Identifier of the session triggering the trace."),
    },
    release: {
      sql: "coalesce(traces.`release`, '')",
      alias: "`release`",
      type: "string",
      description: i18nKey("Release version of the trace."),
    },
    version: {
      sql: "coalesce(traces.version, '')",
      alias: "version",
      type: "string",
      description: i18nKey("Version of the trace."),
    },
    environment: {
      sql: "environment",
      type: "string",
      description: i18nKey(
        "Deployment environment (e.g., production, staging).",
      ),
    },
    timestampMonth: {
      sql: "date_format(traces.start_time, '%Y-%m')",
      alias: "timestampMonth",
      type: "string",
      description: i18nKey("Month of the trace timestamp in YYYY-MM format."),
    },
    observationName: {
      sql: "name",
      alias: "observationName",
      type: "string",
      relationTable: "observations",
      description: i18nKey("Name of the observation."),
    },
    scoreName: {
      sql: "name",
      alias: "scoreName",
      type: "string",
      relationTable: "scores",
      description: i18nKey("Name of the score."),
    },
  },
  measures: {
    count: {
      sql: "count(*)",
      alias: "count",
      type: "integer",
      description: i18nKey("Total number of traces."),
      unit: "traces",
    },
    observationsCount: {
      // observation_count in the MV shape counts non-root spans; + 1 restores
      // the root span so the value matches the previous count over all
      // spans rows of the trace (every traces_scalar row was written
      // from exactly one root span).
      sql: "max(observations_agg.observation_count) + 1",
      alias: "observationsCount",
      type: "integer",
      relationTable: "observations_agg",
      description: i18nKey("Number of observations within the trace."),
      unit: "observations",
    },
    scoresCount: {
      sql: "count(scores.id)",
      alias: "scoresCount",
      type: "integer",
      relationTable: "scores",
      description: i18nKey("Unique scores attached to the trace."),
      unit: "scores",
    },
    latency: {
      // max()/min() over the 1-row-per-trace aggregate stay correct under
      // fan-out when another relation (observations, scores) is joined in the
      // same query — unlike the previous sum-over-span-rows shape.
      sql: "milliseconds_diff(max(observations_agg.max_end_time), min(observations_agg.min_start_time))",
      alias: "latency",
      type: "integer",
      relationTable: "observations_agg",
      description: i18nKey(
        "Elapsed time between the first and last observation inside the trace.",
      ),
      unit: "millisecond",
    },
    totalTokens: {
      sql: "max(observations_agg.total_tokens)",
      alias: "totalTokens",
      type: "integer",
      relationTable: "observations_agg",
      description: i18nKey(
        "Sum of tokens consumed by all observations in the trace.",
      ),
      unit: "tokens",
    },
    totalCost: {
      sql: "max(observations_agg.total_cost)",
      alias: "totalCost",
      type: "decimal",
      relationTable: "observations_agg",
      description: i18nKey(
        "Total cost accumulated across observations in the trace.",
      ),
      unit: "USD",
    },
    uniqueUserIds: {
      sql: "count(distinct coalesce(traces.user_id, ''))",
      alias: "uniqueUserIds",
      type: "integer",
      description: i18nKey("Count of unique userIds."),
      unit: "users",
    },
    uniqueSessionIds: {
      sql: "count(distinct coalesce(traces.session_id, ''))",
      alias: "uniqueSessionIds",
      type: "integer",
      description: i18nKey("Count of unique sessionIds."),
      unit: "sessions",
    },
  },
  tableRelations: {
    // Raw span rows — only for observation-level dimensions (observationName).
    // Per-trace metrics use observations_agg below, not this relation.
    observations: {
      name: tableFor(projectId, "spans"),
      joinConditionSql:
        "ON traces.id = observations.trace_id AND traces.project_id = observations.project_id",
      timeDimension: "start_time",
    },
    // trace_metrics_agg rewrite-shaped aggregate (one row per trace). The
    // timeDimension is declaratively required but unused: derived-table
    // relations carry their bounds inside (see RELATION_SQL_* tokens).
    observations_agg: {
      name: traceMetricsAggRelationSql(projectId),
      joinConditionSql:
        "ON traces.id = observations_agg.trace_id AND traces.project_id = observations_agg.project_id",
      timeDimension: "start_time",
    },
    scores: {
      name: "scores",
      joinConditionSql:
        "ON traces.id = scores.trace_id AND traces.project_id = scores.project_id",
      timeDimension: "timestamp",
    },
  },
  // traces_scalar is root-only by construction — no is_root/parent_span_id
  // segment needed.
  segments: [],
  timeDimension: "start_time",
  baseCte: `${tableFor(projectId, "traces_scalar")} traces`,
});

export const observationsViewDoris = (
  projectId: string,
): ViewDeclarationType => ({
  name: "observations",
  description: i18nKey(
    "Observations represent individual requests or operations within a trace. They are grouped into Spans, Generations, and Events.",
  ),
  dimensions: {
    id: {
      sql: "span_id",
      alias: "id",
      type: "string",
      description: i18nKey("Unique identifier for the observation."),
    },
    traceId: {
      sql: "trace_id",
      alias: "traceId",
      type: "string",
      description: i18nKey(
        "Identifier linking the observation to its parent trace.",
      ),
    },
    traceName: {
      sql: "coalesce(traces.name, '')",
      alias: "traceName",
      type: "string",
      relationTable: "traces",
      description: i18nKey("Name of the parent trace."),
    },
    environment: {
      sql: "environment",
      type: "string",
      description: i18nKey(
        "Deployment environment (e.g., production, staging).",
      ),
    },
    parentObservationId: {
      sql: "parent_span_id",
      alias: "parentObservationId",
      type: "string",
      description: i18nKey(
        "Identifier of the parent observation. Empty for the root span.",
      ),
    },
    type: {
      sql: "`type`",
      type: "string",
      description: i18nKey(
        "Type of the observation. Can be a SPAN, GENERATION, or EVENT.",
      ),
    },
    name: {
      sql: "name",
      type: "string",
      description: i18nKey("Name of the observation."),
    },
    level: {
      sql: "level",
      type: "string",
      description: i18nKey("Logging level of the observation."),
    },
    version: {
      sql: "version",
      type: "string",
      description: i18nKey("Version of the observation."),
    },
    tags: {
      // Trace-level fields are NOT denormalized onto child spans under OTel
      // ingestion (only root rows carry them — is_root = 0 rows hold ''/empty
      // for user_id/session_id/release/tags). Read them from the traces_scalar
      // relation like traceName/traceVersion, or every non-root observation
      // buckets under the empty value.
      sql: "traces.tags",
      alias: "tags",
      type: "string[]",
      relationTable: "traces",
      description: i18nKey(
        "User-defined tags associated with the parent trace.",
      ),
    },
    providedModelName: {
      sql: "provided_model_name",
      alias: "providedModelName",
      type: "string",
      description: i18nKey("Name of the model used for the observation."),
    },
    promptName: {
      sql: "prompt_name",
      alias: "promptName",
      type: "string",
      description: i18nKey("Name of the prompt used for the observation."),
    },
    promptVersion: {
      sql: "prompt_version",
      alias: "promptVersion",
      type: "string",
      description: i18nKey("Version of the prompt used for the observation."),
    },
    userId: {
      sql: "coalesce(traces.user_id, '')",
      alias: "userId",
      type: "string",
      relationTable: "traces",
      description: i18nKey(
        "Identifier of the user triggering the parent trace.",
      ),
    },
    sessionId: {
      sql: "coalesce(traces.session_id, '')",
      alias: "sessionId",
      type: "string",
      relationTable: "traces",
      description: i18nKey(
        "Identifier of the session triggering the parent trace.",
      ),
    },
    traceRelease: {
      sql: "coalesce(traces.`release`, '')",
      alias: "traceRelease",
      type: "string",
      relationTable: "traces",
      description: i18nKey("Release version of the parent trace."),
    },
    traceVersion: {
      sql: "coalesce(traces.version, '')",
      alias: "traceVersion",
      type: "string",
      relationTable: "traces",
      description: i18nKey("Version of the parent trace."),
    },
    scoreName: {
      sql: "name",
      alias: "scoreName",
      type: "string",
      relationTable: "scores",
      description: i18nKey("Name of the score."),
    },
    startTimeMonth: {
      sql: "date_format(start_time, '%Y-%m')",
      alias: "startTimeMonth",
      type: "string",
      description: i18nKey(
        "Month of the observation start_time in YYYY-MM format.",
      ),
    },
    toolNames: {
      sql: "map_keys(tool_definitions)",
      alias: "toolNames",
      type: "string[]",
      explodeArray: true,
      description: i18nKey(
        "Names of available tools defined for the observation.",
      ),
    },
    calledToolNames: {
      sql: "tool_call_names",
      alias: "calledToolNames",
      type: "string[]",
      explodeArray: true,
      description: i18nKey(
        "Names of tools that were called by the observation.",
      ),
    },
    costType: {
      sql: "cost_key",
      alias: "costType",
      type: "string",
      description: i18nKey(
        "Cost category key from cost_details map (e.g. 'input', 'output', 'total').",
      ),
      pairExpand: {
        valuesSql: "cost_details",
        valueAlias: "cost_value",
      },
    },
    usageType: {
      sql: "usage_key",
      alias: "usageType",
      type: "string",
      description: i18nKey(
        "Token usage category key from usage_details map (e.g. 'input', 'output', 'total').",
      ),
      pairExpand: {
        valuesSql: "usage_details",
        valueAlias: "usage_value",
      },
    },
  },
  measures: {
    count: {
      sql: "count(*)",
      alias: "count",
      type: "integer",
      description: i18nKey("Total number of observations."),
      unit: "observations",
    },
    latency: {
      sql: "MILLISECONDS_DIFF(any_value(observations.end_time), any_value(observations.start_time))",
      alias: "latency",
      type: "integer",
      description: i18nKey(
        "Latency of an individual observation (start time to end time).",
      ),
      unit: "millisecond",
    },
    streamingLatency: {
      sql: "if(any_value(observations.completion_start_time) is null, CAST(NULL AS Bigint), MILLISECONDS_DIFF(any_value(observations.end_time), any_value(observations.completion_start_time)))",
      alias: "streamingLatency",
      type: "integer",
      description: i18nKey(
        "Latency of the generation step (completion start time to end time).",
      ),
      unit: "millisecond",
    },
    inputTokens: {
      sql: "sum(observations.input_tokens_calculated)",
      alias: "inputTokens",
      type: "integer",
      description: i18nKey("Sum of input tokens consumed by the observation."),
      unit: "tokens",
    },
    outputTokens: {
      sql: "sum(observations.output_tokens_calculated)",
      alias: "outputTokens",
      type: "integer",
      description: i18nKey("Sum of output tokens produced by the observation."),
      unit: "tokens",
    },
    totalTokens: {
      sql: "sum(observations.total_tokens_calculated)",
      alias: "totalTokens",
      type: "integer",
      description: i18nKey("Sum of tokens consumed by the observation."),
      unit: "tokens",
    },
    outputTokensPerSecond: {
      // Calculate average output tokens per second. Denominator uses seconds to align
      // with the `tokens/s` unit; NULL values avoided by guarding against a 0-second
      // duration.
      sql: "sum(observations.output_tokens_calculated) / nullIf(SECONDS_DIFF(any_value(observations.end_time), any_value(observations.completion_start_time)), 0)",
      alias: "outputTokensPerSecond",
      type: "decimal",
      description: i18nKey(
        "Average number of output tokens produced per second between completion start time and span end time.",
      ),
      unit: "tokens/s",
    },
    tokensPerSecond: {
      sql: "sum(observations.total_tokens_calculated) / SECONDS_DIFF(any_value(observations.end_time), any_value(observations.start_time))",
      alias: "tokensPerSecond",
      type: "decimal",
      description: i18nKey(
        "Average number of tokens consumed per second by the observation.",
      ),
      unit: "tokens/s",
    },
    inputCost: {
      sql: "sum(observations.input_cost_calculated)",
      alias: "inputCost",
      type: "decimal",
      description: i18nKey("Sum of input cost incurred by the observation."),
      unit: "USD",
    },
    outputCost: {
      sql: "sum(observations.output_cost_calculated)",
      alias: "outputCost",
      type: "decimal",
      description: i18nKey("Sum of output cost incurred by the observation."),
      unit: "USD",
    },
    totalCost: {
      sql: "sum(observations.total_cost)",
      alias: "totalCost",
      type: "decimal",
      description: i18nKey("Total cost of the observation."),
      unit: "USD",
    },
    timeToFirstToken: {
      // Return NULL if `completion_start_time` is NULL to represent unknown TTFT
      sql: "if(isNull(any_value(observations.completion_start_time)), CAST(NULL AS Bigint), milliseconds_diff(any_value(observations.completion_start_time),any_value(observations.start_time)))",
      alias: "timeToFirstToken",
      type: "integer",
      description: i18nKey("Time to first token for the observation."),
      unit: "millisecond",
    },
    countScores: {
      sql: "count(scores.id)",
      alias: "countScores",
      type: "integer",
      relationTable: "scores",
      description: i18nKey("Unique scores attached to the observation."),
      unit: "scores",
    },
    toolDefinitions: {
      sql: "ifNull(size(observations.tool_definitions), 0)",
      alias: "toolDefinitions",
      type: "integer",
      description: i18nKey("Number of available tools per observation."),
      unit: "tools",
    },
    toolCalls: {
      sql: "ifNull(size(observations.tool_calls), 0)",
      alias: "toolCalls",
      type: "integer",
      description: i18nKey("Number of tool calls per observation."),
      unit: "calls",
    },
    costByType: {
      sql: "cost_value",
      alias: "costByType",
      type: "decimal",
      unit: "USD",
      requiresDimension: "costType",
      description: i18nKey(
        "Sum of cost per category. The costType dimension is auto-included to emit the LATERAL VIEW that brings cost_value into scope.",
      ),
    },
    usageByType: {
      sql: "usage_value",
      alias: "usageByType",
      type: "integer",
      unit: "tokens",
      requiresDimension: "usageType",
      description: i18nKey(
        "Sum of token usage per category. The usageType dimension is auto-included to emit the LATERAL VIEW that brings usage_value into scope.",
      ),
    },
  },
  tableRelations: {
    traces: {
      name: tableFor(projectId, "traces_scalar"),
      joinConditionSql:
        "ON observations.trace_id = traces.id AND observations.project_id = traces.project_id",
      timeDimension: "start_time",
    },
    scores: {
      name: "scores",
      joinConditionSql:
        "ON observations.trace_id = scores.trace_id AND observations.project_id = scores.project_id",
      timeDimension: "timestamp",
    },
  },
  // Phase B alignment with upstream: every spans row is an
  // observation now (no more synthetic `t-<trace_id>` rows). The previous
  // segment `is_root = 0` filtered those out; with the synth
  // rows gone it would instead exclude root observations, which is
  // wrong. No segment is needed.
  segments: [],
  timeDimension: "start_time",
  baseCte: `${tableFor(projectId, "spans")} observations`,
});

// Base dimensions for score views (shared between numeric and categorical)
export const scoreBaseDimensionsDoris = {
  id: {
    sql: "id",
    type: "string",
    description: i18nKey("Unique identifier of the score entry."),
  },
  environment: {
    sql: "environment",
    type: "string",
    description: i18nKey("Deployment environment (e.g., production, staging)."),
  },
  name: {
    sql: "name",
    type: "string",
    description: i18nKey("Name of the score (e.g., accuracy, toxicity)."),
  },
  source: {
    sql: "source",
    type: "string",
    description: i18nKey(
      "Origin of the score. Can be API, ANNOTATION, or EVAL.",
    ),
  },
  dataType: {
    sql: "data_type",
    alias: "dataType",
    type: "string",
    description: i18nKey(
      "Internal data type of the score (NUMERIC, BOOLEAN, CATEGORICAL).",
    ),
  },
  traceId: {
    sql: "trace_id",
    alias: "traceId",
    type: "string",
    description: i18nKey("Identifier of the parent trace."),
  },
  traceName: {
    sql: "coalesce(traces.name, '')",
    alias: "traceName",
    type: "string",
    relationTable: "traces",
    description: i18nKey("Name of the parent trace."),
  },
  tags: {
    sql: "tags",
    type: "string[]",
    relationTable: "traces",
    description: i18nKey("User-defined tags associated with the trace."),
  },
  userId: {
    sql: "coalesce(traces.user_id, '')",
    alias: "userId",
    type: "string",
    relationTable: "traces",
    description: i18nKey("Identifier of the user triggering the trace."),
  },
  sessionId: {
    sql: "coalesce(traces.session_id, '')",
    alias: "sessionId",
    type: "string",
    relationTable: "traces",
    description: i18nKey("Identifier of the session triggering the trace."),
  },
  traceRelease: {
    sql: "coalesce(traces.`release`, '')",
    alias: "traceRelease",
    type: "string",
    relationTable: "traces",
    description: i18nKey("Release version of the parent trace."),
  },
  traceVersion: {
    sql: "coalesce(traces.version, '')",
    alias: "traceVersion",
    type: "string",
    relationTable: "traces",
    description: i18nKey("Version of the parent trace."),
  },
  observationId: {
    sql: "observation_id",
    alias: "observationId",
    type: "string",
    description: i18nKey(
      "Identifier of the observation associated with the score.",
    ),
  },
  observationName: {
    sql: "name",
    alias: "observationName",
    type: "string",
    relationTable: "observations",
    description: i18nKey("Name of the observation associated with the score."),
  },
  observationModelName: {
    sql: "provided_model_name",
    alias: "observationModelName",
    type: "string",
    relationTable: "observations",
    description: i18nKey("Name of the model used for the observation."),
  },
  observationPromptName: {
    sql: "prompt_name",
    alias: "observationPromptName",
    type: "string",
    relationTable: "observations",
    description: i18nKey("Name of the prompt used for the observation."),
  },
  observationPromptVersion: {
    sql: "prompt_version",
    alias: "observationPromptVersion",
    type: "string",
    relationTable: "observations",
    description: i18nKey("Version of the prompt used for the observation."),
  },
  configId: {
    sql: "config_id",
    alias: "configId",
    type: "string",
    description: i18nKey("Identifier of the config associated with the score."),
  },
};

export const scoresNumericViewDoris = (
  projectId: string,
): ViewDeclarationType => ({
  name: "scores_numeric",
  description: i18nKey(
    "Scores are flexible objects that are used for evaluations. This view contains numeric scores.",
  ),
  dimensions: {
    ...scoreBaseDimensionsDoris,
  },
  measures: {
    count: {
      sql: "count(*)",
      alias: "count",
      type: "integer",
      description: i18nKey("Total number of scores."),
      unit: "scores",
    },
    value: {
      sql: "any_value(`value`)",
      alias: "value",
      type: "number",
      description: i18nKey("Value of the score."),
    },
  },
  tableRelations: {
    traces: {
      name: tableFor(projectId, "traces_scalar"),
      joinConditionSql:
        "ON scores_numeric.trace_id = traces.id AND scores_numeric.project_id = traces.project_id",
      timeDimension: "start_time",
    },
    observations: {
      name: tableFor(projectId, "spans"),
      joinConditionSql:
        "ON scores_numeric.observation_id = observations.span_id AND scores_numeric.project_id = observations.project_id",
      timeDimension: "start_time",
    },
  },
  segments: [
    {
      column: "data_type",
      // We consider NUMERIC and BOOLEAN scores as numeric.
      operator: "does not contain",
      value: "CATEGORICAL",
      type: "string",
    },
  ],
  timeDimension: "timestamp",
  baseCte: `scores scores_numeric`,
});

export const scoresCategoricalViewDoris = (
  projectId: string,
): ViewDeclarationType => ({
  name: "scores_categorical",
  description: i18nKey(
    "Scores are flexible objects that are used for evaluations. This view contains categorical scores.",
  ),
  dimensions: {
    ...scoreBaseDimensionsDoris,
    stringValue: {
      sql: "string_value",
      alias: "stringValue",
      type: "string",
      description: i18nKey("Value of the score."),
    },
  },
  measures: {
    count: {
      sql: "count(*)",
      alias: "count",
      type: "integer",
      description: i18nKey("Total number of scores."),
      unit: "scores",
    },
  },
  tableRelations: {
    traces: {
      name: tableFor(projectId, "traces_scalar"),
      joinConditionSql:
        "ON scores_categorical.trace_id = traces.id AND scores_categorical.project_id = traces.project_id",
      timeDimension: "start_time",
    },
    observations: {
      name: tableFor(projectId, "spans"),
      joinConditionSql:
        "ON scores_categorical.observation_id = observations.span_id AND scores_categorical.project_id = observations.project_id",
      timeDimension: "start_time",
    },
  },
  segments: [
    {
      column: "data_type",
      operator: "=",
      value: "CATEGORICAL",
      type: "string",
    },
  ],
  timeDimension: "timestamp",
  baseCte: `scores scores_categorical`,
});

export const viewDeclarationsDoris = {
  traces: tracesViewDoris,
  observations: observationsViewDoris,
  "scores-numeric": scoresNumericViewDoris,
  "scores-categorical": scoresCategoricalViewDoris,
} as const;
