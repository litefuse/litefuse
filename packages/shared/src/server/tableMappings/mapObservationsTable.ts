// This structure is maintained to relate the frontend table definitions with the Doris table definitions.
// The frontend only sends the column names to the backend. This needs to be changed in the future to send column IDs.

import { UiColumnMappings } from "../../tableDefinitions";

export const observationsTableTraceUiColumnDefinitions: UiColumnMappings = [
  {
    uiTableName: "Trace Tags",
    uiTableId: "traceTags",
    tableName: "traces",
    select: "t.tags",
  },
  {
    uiTableName: "User ID",
    uiTableId: "userId",
    tableName: "traces",
    select: "t.`user_id`",
  },
  {
    uiTableName: "Session ID",
    uiTableId: "sessionId",
    tableName: "traces",
    select: "t.`session_id`",
  },
  {
    uiTableName: "Trace Name",
    uiTableId: "traceName",
    tableName: "traces",
    select: "t.`name`",
  },
  {
    uiTableName: "Trace Environment",
    uiTableId: "traceEnvironment",
    tableName: "traces",
    select: "t.`environment`",
  },
];
// Trace-level fields on observation rows: best-effort denormalised at write
// time onto o.*, authoritatively present on the synthetic trace span row
// (joined as t). COALESCE prefers the denormalised value (no JOIN row read
// needed in the common case) and falls back to the trace span when an obs
// landed before its trace (e.g. OTel child spans without trace attributes).
// tableName: "traces" keeps the JOIN trigger in the existing filter machinery.
export const observationsTableTraceUiColumnDefinitionsForDoris: UiColumnMappings =
  [
    {
      uiTableName: "Trace Tags",
      uiTableId: "traceTags",
      tableName: "traces",
      select: "COALESCE(o.tags, t.tags)",
    },
    {
      uiTableName: "User ID",
      uiTableId: "userId",
      tableName: "traces",
      select: "COALESCE(NULLIF(o.user_id, ''), t.user_id)",
    },
    {
      uiTableName: "Session ID",
      uiTableId: "sessionId",
      tableName: "traces",
      select: "COALESCE(NULLIF(o.session_id, ''), t.session_id)",
    },
    {
      uiTableName: "Trace Name",
      uiTableId: "traceName",
      tableName: "traces",
      select: "COALESCE(NULLIF(o.trace_name, ''), t.name)",
    },
    {
      uiTableName: "Trace Environment",
      uiTableId: "traceEnvironment",
      tableName: "traces",
      select: "COALESCE(NULLIF(o.environment, ''), t.environment)",
    },
  ];

export const observationsTableUiColumnDefinitions: UiColumnMappings = [
  ...observationsTableTraceUiColumnDefinitions,
  {
    uiTableName: "Environment",
    uiTableId: "environment",
    tableName: "observations",
    select: "o.`environment`",
  },
  {
    uiTableName: "type",
    uiTableId: "type",
    tableName: "observations",
    select: "o.`type`",
  },
  {
    uiTableName: "ID",
    uiTableId: "id",
    tableName: "observations",
    select: "o.`id`",
  },
  {
    uiTableName: "Type",
    uiTableId: "type",
    tableName: "observations",
    select: "o.`type`",
  },
  {
    uiTableName: "Name",
    uiTableId: "name",
    tableName: "observations",
    select: "o.`name`",
  },
  {
    uiTableName: "Trace ID",
    uiTableId: "traceId",
    tableName: "observations",
    select: "o.`trace_id`",
  },
  {
    uiTableName: "Parent Observation ID",
    uiTableId: "parentObservationId",
    tableName: "observations",
    select: "o.`parent_observation_id`",
  },

  {
    uiTableName: "Start Time",
    uiTableId: "startTime",
    tableName: "observations",
    select: "o.`start_time`",
  },
  {
    uiTableName: "End Time",
    uiTableId: "endTime",
    tableName: "observations",
    select: "o.`end_time`",
  },
  {
    uiTableName: "Time To First Token (s)",
    uiTableId: "timeToFirstToken",
    tableName: "observations",
    select:
      "if(isNull(completion_start_time), NULL,  date_diff('millisecond', start_time, completion_start_time) / 1000)",
    // If we use the default of Decimal64(12), we cannot filter for more than ~40min due to an overflow
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Latency (s)",
    uiTableId: "latency",
    tableName: "observations",
    select:
      "if(isNull(end_time), NULL, date_diff('millisecond', start_time, end_time) / 1000)",
    // If we use the default of Decimal64(12), we cannot filter for more than ~40min due to an overflow
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Tokens per second",
    uiTableId: "tokensPerSecond",
    tableName: "observations",
    select:
      "(arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'output') > 0, usage_details))) / (date_diff('millisecond', start_time, end_time) / 1000))",
  },
  {
    uiTableName: "Input Cost ($)",
    uiTableId: "inputCost",
    tableName: "observations",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'input') > 0, cost_details)))",
  },
  {
    uiTableName: "Output Cost ($)",
    uiTableId: "outputCost",
    tableName: "observations",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'output') > 0, cost_details)))",
  },
  {
    uiTableName: "Total Cost ($)",
    uiTableId: "totalCost",
    tableName: "observations",
    select:
      "if(mapExists((k, v) -> (k = 'total'), cost_details), cost_details['total'], NULL)",
  },
  {
    uiTableName: "Level",
    uiTableId: "level",
    tableName: "observations",
    select: "o.`level`",
  },
  {
    uiTableName: "Status Message",
    uiTableId: "statusMessage",
    tableName: "observations",
    select: "o.`status_message`",
  },
  {
    uiTableName: "Model",
    uiTableId: "model",
    tableName: "observations",
    select: "o.`provided_model_name`",
  },
  {
    uiTableName: "Model ID",
    uiTableId: "modelId",
    tableName: "observations",
    select: "o.`internal_model_id`",
  },
  {
    uiTableName: "Input Tokens",
    uiTableId: "inputTokens",
    tableName: "observations",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'input') > 0, usage_details)))",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Output Tokens",
    uiTableId: "outputTokens",
    tableName: "observations",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'output') > 0, usage_details)))",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Total Tokens",
    uiTableId: "totalTokens",
    tableName: "observations",
    select:
      "if(mapExists((k, v) -> (k = 'total'), usage_details), usage_details['total'], NULL)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Tokens",
    uiTableId: "tokens",
    tableName: "observations",
    select:
      "if(mapExists((k, v) -> (k = 'total'), usage_details), usage_details['total'], NULL)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Metadata",
    uiTableId: "metadata",
    tableName: "observations",
    select: "o.`metadata`",
  },
  // Scores column duplicated to allow renaming column name. Will be removed once session storage cache is outdated
  // Column names are cached in user sessions - changing them breaks existing filters
  {
    uiTableName: "Scores",
    uiTableId: "scores",
    tableName: "scores",
    select: "s.scores_avg",
  },
  {
    uiTableName: "Scores (numeric)",
    uiTableId: "scores_avg",
    tableName: "scores",
    select: "s.scores_avg",
  },
  {
    uiTableName: "Scores (categorical)",
    uiTableId: "score_categories",
    tableName: "scores",
    select: "s.score_categories",
  },
  {
    uiTableName: "Version",
    uiTableId: "version",
    tableName: "observations",
    select: "o.`version`",
  },
  {
    uiTableName: "Prompt Name",
    uiTableId: "promptName",
    tableName: "observations",
    select: "o.prompt_name",
  },
  {
    uiTableName: "Prompt Version",
    uiTableId: "promptVersion",
    tableName: "observations",
    select: "o.prompt_version",
  },
  {
    uiTableName: "Available Tools",
    uiTableId: "toolDefinitions",
    tableName: "observations",
    select: "length(mapKeys(o.tool_definitions))",
  },
  {
    uiTableName: "Tool Calls",
    uiTableId: "toolCalls",
    tableName: "observations",
    select: "length(o.tool_calls)",
  },
  {
    uiTableName: "Tool Names",
    uiTableId: "toolNames",
    tableName: "observations",
    select: "mapKeys(o.tool_definitions)",
  },
  {
    uiTableName: "Called Tool Names",
    uiTableId: "calledToolNames",
    tableName: "observations",
    select: "o.tool_call_names",
  },
];

export const observationsTableUiColumnDefinitionsForDoris: UiColumnMappings = [
  ...observationsTableTraceUiColumnDefinitionsForDoris,
  {
    uiTableName: "Environment",
    uiTableId: "environment",
    tableName: "observations",
    select: "o.environment",
  },
  {
    uiTableName: "type",
    uiTableId: "type",
    tableName: "observations",
    select: "o.type",
  },
  {
    uiTableName: "ID",
    uiTableId: "id",
    tableName: "observations",
    select: "o.span_id",
  },
  {
    uiTableName: "Type",
    uiTableId: "type",
    tableName: "observations",
    select: "o.type",
  },
  {
    uiTableName: "Name",
    uiTableId: "name",
    tableName: "observations",
    select: "o.name",
  },
  {
    uiTableName: "Trace ID",
    uiTableId: "traceId",
    tableName: "observations",
    select: "o.trace_id",
  },

  {
    uiTableName: "Start Time",
    uiTableId: "startTime",
    tableName: "observations",
    select: "o.start_time",
  },
  {
    uiTableName: "End Time",
    uiTableId: "endTime",
    tableName: "observations",
    select: "o.end_time",
  },
  {
    uiTableName: "Time To First Token (s)",
    uiTableId: "timeToFirstToken",
    tableName: "observations",
    select:
      "if(isNull(o.completion_start_time), NULL, milliseconds_diff(o.completion_start_time, o.start_time) / 1000)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Latency (s)",
    uiTableId: "latency",
    tableName: "observations",
    select:
      "if(isNull(o.end_time), NULL, milliseconds_diff(o.end_time, o.start_time) / 1000)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Tokens per second",
    uiTableId: "tokensPerSecond",
    tableName: "observations",
    select:
      "if(isNull(o.end_time) OR milliseconds_diff(o.end_time, o.start_time) = 0, NULL, COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%output%', map_values(o.usage_details), map_keys(o.usage_details))), 0) / (milliseconds_diff(o.end_time, o.start_time) / 1000))",
  },
  {
    uiTableName: "Input Cost ($)",
    uiTableId: "inputCost",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%input%', map_values(o.cost_details), map_keys(o.cost_details))), 0)",
  },
  {
    uiTableName: "Output Cost ($)",
    uiTableId: "outputCost",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%output%', map_values(o.cost_details), map_keys(o.cost_details))), 0)",
  },
  {
    uiTableName: "Total Cost ($)",
    uiTableId: "totalCost",
    tableName: "observations",
    // Mirror inputCost / outputCost: missing cost is treated as 0 so a
    // range filter "0–N" includes obs without any cost data. The displayed
    // Total Cost column in the obs list (selected as o.total_cost) still
    // renders NULL as "n/a"; only the filter expression coerces to 0.
    select: "COALESCE(o.total_cost, 0)",
  },
  {
    uiTableName: "Level",
    uiTableId: "level",
    tableName: "observations",
    select: "o.level",
  },
  {
    uiTableName: "Status Message",
    uiTableId: "statusMessage",
    tableName: "observations",
    select: "o.status_message",
  },
  {
    uiTableName: "Model",
    uiTableId: "model",
    tableName: "observations",
    select: "o.provided_model_name",
  },
  {
    uiTableName: "Model ID",
    uiTableId: "modelId",
    tableName: "observations",
    select: "o.model_id",
  },
  {
    uiTableName: "Input Tokens",
    uiTableId: "inputTokens",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%input%', map_values(o.usage_details), map_keys(o.usage_details))), 0)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Output Tokens",
    uiTableId: "outputTokens",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%output%', map_values(o.usage_details), map_keys(o.usage_details))), 0)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Total Tokens",
    uiTableId: "totalTokens",
    tableName: "observations",
    select:
      "if(MAP_CONTAINS_KEY(o.usage_details, 'total'), o.usage_details['total'], NULL)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Tokens",
    uiTableId: "tokens",
    tableName: "observations",
    select:
      "if(MAP_CONTAINS_KEY(o.usage_details, 'total'), o.usage_details['total'], NULL)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Metadata",
    uiTableId: "metadata",
    tableName: "observations",
    select: "o.metadata",
  },
  // Scores column duplicated to allow renaming column name. Will be removed once session storage cache is outdated
  // Column names are cached in user sessions - changing them breaks existing filters
  {
    uiTableName: "Scores",
    uiTableId: "scores",
    tableName: "scores",
    select: "s.scores_avg",
  },
  {
    uiTableName: "Scores (numeric)",
    uiTableId: "scores_avg",
    tableName: "scores",
    select: "s.scores_avg",
  },
  {
    uiTableName: "Scores (categorical)",
    uiTableId: "score_categories",
    tableName: "scores",
    select: "s.score_categories",
  },
  {
    uiTableName: "Version",
    uiTableId: "version",
    tableName: "observations",
    select: "o.version",
  },
  {
    uiTableName: "Prompt Name",
    uiTableId: "promptName",
    tableName: "observations",
    select: "o.prompt_name",
  },
  {
    uiTableName: "Prompt Version",
    uiTableId: "promptVersion",
    tableName: "observations",
    select: "o.prompt_version",
  },
  {
    uiTableName: "Available Tools",
    uiTableId: "toolDefinitions",
    tableName: "observations",
    select: "map_size(o.tool_definitions)",
  },
  {
    uiTableName: "Tool Calls",
    uiTableId: "toolCalls",
    tableName: "observations",
    select: "array_size(o.tool_calls)",
  },
  {
    uiTableName: "Tool Names",
    uiTableId: "toolNames",
    tableName: "observations",
    select: "map_keys(o.tool_definitions)",
  },
  {
    uiTableName: "Called Tool Names",
    uiTableId: "calledToolNames",
    tableName: "observations",
    select: "o.tool_call_names",
  },
];
