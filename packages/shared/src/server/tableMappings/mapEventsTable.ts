// This structure is maintained to relate the frontend table definitions with the Doris table definitions.
// The frontend only sends the column names to the backend. This needs to be changed in the future to send column IDs.

import { UiColumnMappings } from "../../tableDefinitions";

export const eventsTableNativeUiColumnDefinitions: UiColumnMappings = [
  {
    uiTableName: "Environment",
    uiTableId: "environment",
    tableName: "events_proto",
    select: "e.`environment`",
  },
  {
    uiTableName: "Type",
    uiTableId: "type",
    tableName: "events_proto",
    select: "e.`type`",
  },
  {
    uiTableName: "ID",
    uiTableId: "id",
    tableName: "events_proto",
    select: "e.`span_id`",
  },
  {
    uiTableName: "Name",
    uiTableId: "name",
    tableName: "events_proto",
    select: "e.`name`",
  },
  {
    uiTableName: "Trace ID",
    uiTableId: "traceId",
    tableName: "events_proto",
    select: "e.`trace_id`",
  },

  {
    uiTableName: "Start Time",
    uiTableId: "startTime",
    tableName: "events_proto",
    select: "e.`start_time`",
  },
  {
    uiTableName: "End Time",
    uiTableId: "endTime",
    tableName: "events_proto",
    select: "e.`end_time`",
  },
  {
    uiTableName: "Time To First Token (s)",
    uiTableId: "timeToFirstToken",
    tableName: "events_proto",
    select:
      "if(isNull(e.completion_start_time), NULL,  date_diff('millisecond', e.start_time, e.completion_start_time) / 1000)",
    // If we use the default of Decimal64(12), we cannot filter for more than ~40min due to an overflow
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Latency (s)",
    uiTableId: "latency",
    tableName: "events_proto",
    select:
      "if(isNull(e.end_time), NULL, date_diff('millisecond', e.start_time, e.end_time) / 1000)",
    // If we use the default of Decimal64(12), we cannot filter for more than ~40min due to an overflow
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Tokens per second",
    uiTableId: "tokensPerSecond",
    tableName: "events_proto",
    select:
      "(arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'output') > 0, usage_details))) / (date_diff('millisecond', start_time, end_time) / 1000))",
  },
  {
    uiTableName: "Input Cost ($)",
    uiTableId: "inputCost",
    tableName: "events_proto",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'input') > 0, cost_details)))",
  },
  {
    uiTableName: "Output Cost ($)",
    uiTableId: "outputCost",
    tableName: "events_proto",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'output') > 0, cost_details)))",
  },
  {
    uiTableName: "Total Cost ($)",
    uiTableId: "totalCost",
    tableName: "events_proto",
    select:
      "if(mapExists((k, v) -> (k = 'total'), cost_details), cost_details['total'], NULL)",
  },
  {
    uiTableName: "Level",
    uiTableId: "level",
    tableName: "events_proto",
    select: "e.`level`",
  },
  {
    uiTableName: "Status Message",
    uiTableId: "statusMessage",
    tableName: "events_proto",
    select: "e.`status_message`",
  },
  {
    uiTableName: "Model",
    uiTableId: "model",
    tableName: "events_proto",
    select: "e.`provided_model_name`",
  },
  {
    uiTableName: "Provided Model Name",
    uiTableId: "providedModelName",
    tableName: "events_proto",
    select: "e.`provided_model_name`",
  },
  {
    uiTableName: "Model ID",
    uiTableId: "modelId",
    tableName: "events_proto",
    select: "e.`model_id`",
  },
  {
    uiTableName: "Input Tokens",
    uiTableId: "inputTokens",
    tableName: "events_proto",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'input') > 0, usage_details)))",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Output Tokens",
    uiTableId: "outputTokens",
    tableName: "events_proto",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'output') > 0, usage_details)))",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Total Tokens",
    uiTableId: "totalTokens",
    tableName: "events_proto",
    select:
      "if(mapExists((k, v) -> (k = 'total'), usage_details), usage_details['total'], NULL)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Tokens",
    uiTableId: "tokens",
    tableName: "events_proto",
    select:
      "if(mapExists((k, v) -> (k = 'total'), usage_details), usage_details['total'], NULL)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Metadata",
    uiTableId: "metadata",
    tableName: "events_proto",
    select: "e.`metadata`",
  },
  {
    uiTableName: "Version",
    uiTableId: "version",
    tableName: "events_proto",
    select: "e.`version`",
  },
  {
    uiTableName: "Prompt Name",
    uiTableId: "promptName",
    tableName: "events_proto",
    select: "e.prompt_name",
  },
  {
    uiTableName: "Prompt Version",
    uiTableId: "promptVersion",
    tableName: "events_proto",
    select: "e.prompt_version",
  },
  {
    uiTableName: "Input",
    uiTableId: "input",
    tableName: "events_proto",
    select: "e.input",
  },
  {
    uiTableName: "Output",
    uiTableId: "output",
    tableName: "events_proto",
    select: "e.output",
  },
  {
    uiTableName: "Session ID",
    uiTableId: "sessionId",
    tableName: "events_proto",
    select: "e.`session_id`",
  },
  {
    uiTableName: "Trace Name",
    uiTableId: "traceName",
    tableName: "events_proto",
    select: "e.`trace_name`",
  },
  {
    uiTableName: "User ID",
    uiTableId: "userId",
    tableName: "events_proto",
    select: "e.`user_id`",
  },
  {
    uiTableName: "Trace Tags",
    uiTableId: "traceTags",
    tableName: "events_proto",
    select: "e.`tags`",
  },
  {
    uiTableName: "Tags",
    uiTableId: "tags",
    tableName: "events_proto",
    select: "e.`tags`",
  },
  {
    uiTableName: "Trace Environment",
    uiTableId: "traceEnvironment",
    tableName: "events_proto",
    select: "e.`environment`",
  },
  {
    uiTableName: "Has Parent Observation",
    uiTableId: "hasParentObservation",
    tableName: "events_proto",
    select: "e.parent_span_id != ''",
  },
  {
    uiTableName: "Parent Observation ID",
    uiTableId: "parentObservationId",
    tableName: "events_proto",
    select: "e.`parent_span_id`",
    emptyEqualsNull: true,
  },
  {
    uiTableName: "Experiment Dataset ID",
    uiTableId: "experimentDatasetId",
    tableName: "events_proto",
    select: "e.`experiment_dataset_id`",
  },
  {
    uiTableName: "Experiment ID",
    uiTableId: "experimentId",
    tableName: "events_proto",
    select: "e.`experiment_id`",
  },
  {
    uiTableName: "Experiment Name",
    uiTableId: "experimentName",
    tableName: "events_proto",
    select: "e.`experiment_name`",
  },
  {
    uiTableName: "Available Tools",
    uiTableId: "toolDefinitions",
    tableName: "events_proto",
    select: "length(mapKeys(e.tool_definitions))",
  },
  {
    uiTableName: "Tool Calls",
    uiTableId: "toolCalls",
    tableName: "events_proto",
    select: "length(e.tool_calls)",
  },
  {
    uiTableName: "Tool Names",
    uiTableId: "toolNames",
    tableName: "events_proto",
    select: "mapKeys(e.tool_definitions)",
  },
  {
    uiTableName: "Called Tool Names",
    uiTableId: "calledToolNames",
    tableName: "events_proto",
    select: "e.tool_call_names",
  },
];

export const eventsTableUiColumnDefinitions: UiColumnMappings = [
  ...eventsTableNativeUiColumnDefinitions,
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
    uiTableName: "Trace Scores (numeric)",
    uiTableId: "trace_scores_avg",
    tableName: "scores",
    select: "ts.scores_avg",
  },
  {
    uiTableName: "Trace Scores (categorical)",
    uiTableId: "trace_score_categories",
    tableName: "scores",
    select: "ts.score_categories",
  },
  {
    uiTableName: "Comment Count",
    uiTableId: "commentCount",
    tableName: "comments",
    select: "", // handled by comment filter helpers
  },
  {
    uiTableName: "Comment Content",
    uiTableId: "commentContent",
    tableName: "comments",
    select: "", // handled by comment filter helpers
  },
];

// Doris-specific column definitions without backticks and with Doris-compatible functions
export const eventsTableNativeUiColumnDefinitionsForDoris: UiColumnMappings = [
  {
    uiTableName: "Environment",
    uiTableId: "environment",
    tableName: "observations",
    select: "o.environment",
  },
  {
    uiTableName: "Type",
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
      "(sum(if(MAP_CONTAINS_KEY(o.usage_details,'output'),o.usage_details['output'],0))) / (milliseconds_diff(any_value(o.end_time),any_value(o.start_time)) / 1000)",
  },
  {
    uiTableName: "Input Cost ($)",
    uiTableId: "inputCost",
    tableName: "observations",
    select:
      "sum(if(MAP_CONTAINS_KEY(o.cost_details,'input'),o.cost_details['input'],0))",
  },
  {
    uiTableName: "Output Cost ($)",
    uiTableId: "outputCost",
    tableName: "observations",
    select:
      "sum(if(MAP_CONTAINS_KEY(o.cost_details,'output'),o.cost_details['output'],0))",
  },
  {
    uiTableName: "Total Cost ($)",
    uiTableId: "totalCost",
    tableName: "observations",
    select:
      "if(MAP_CONTAINS_KEY(o.cost_details,'total'), o.cost_details['total'], NULL)",
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
    uiTableName: "Provided Model Name",
    uiTableId: "providedModelName",
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
      "sum(if(MAP_CONTAINS_KEY(o.usage_details,'input'),o.usage_details['input'],0))",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Output Tokens",
    uiTableId: "outputTokens",
    tableName: "observations",
    select:
      "sum(if(MAP_CONTAINS_KEY(o.usage_details,'output'),o.usage_details['output'],0))",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Total Tokens",
    uiTableId: "totalTokens",
    tableName: "observations",
    select:
      "if(MAP_CONTAINS_KEY(o.usage_details,'total'), o.usage_details['total'], NULL)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Tokens",
    uiTableId: "tokens",
    tableName: "observations",
    select:
      "if(MAP_CONTAINS_KEY(o.usage_details,'total'), o.usage_details['total'], NULL)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Metadata",
    uiTableId: "metadata",
    tableName: "observations",
    select: "o.metadata",
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
    uiTableName: "Input",
    uiTableId: "input",
    tableName: "observations",
    select: "o.input",
  },
  {
    uiTableName: "Output",
    uiTableId: "output",
    tableName: "observations",
    select: "o.output",
  },
  {
    uiTableName: "Session ID",
    uiTableId: "sessionId",
    tableName: "observations",
    select: "o.session_id",
  },
  {
    uiTableName: "Trace Name",
    uiTableId: "traceName",
    tableName: "observations",
    select: "o.trace_name",
  },
  {
    uiTableName: "User ID",
    uiTableId: "userId",
    tableName: "observations",
    select: "o.user_id",
  },
  {
    uiTableName: "Trace Tags",
    uiTableId: "traceTags",
    tableName: "observations",
    select: "o.tags",
  },
  {
    uiTableName: "Tags",
    uiTableId: "tags",
    tableName: "observations",
    select: "o.tags",
  },
  {
    uiTableName: "Trace Environment",
    uiTableId: "traceEnvironment",
    tableName: "observations",
    select: "o.environment",
  },
  {
    uiTableName: "Has Parent Observation",
    uiTableId: "hasParentObservation",
    tableName: "observations",
    select: "o.parent_span_id != ''",
  },
  {
    uiTableName: "Parent Observation ID",
    uiTableId: "parentObservationId",
    tableName: "observations",
    select: "o.parent_span_id",
    emptyEqualsNull: true,
  },
  {
    uiTableName: "Experiment Dataset ID",
    uiTableId: "experimentDatasetId",
    tableName: "observations",
    select: "o.experiment_dataset_id",
  },
  {
    uiTableName: "Experiment ID",
    uiTableId: "experimentId",
    tableName: "observations",
    select: "o.experiment_id",
  },
  {
    uiTableName: "Experiment Name",
    uiTableId: "experimentName",
    tableName: "observations",
    select: "o.experiment_name",
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

export const eventsTableUiColumnDefinitionsForDoris: UiColumnMappings = [
  ...eventsTableNativeUiColumnDefinitionsForDoris,
  // Scores column duplicated to allow renaming column name. Will be removed once session storage cache is outdated
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
    uiTableName: "Trace Scores (numeric)",
    uiTableId: "trace_scores_avg",
    tableName: "scores",
    select: "ts.scores_avg",
  },
  {
    uiTableName: "Trace Scores (categorical)",
    uiTableId: "trace_score_categories",
    tableName: "scores",
    select: "ts.score_categories",
  },
  {
    uiTableName: "Comment Count",
    uiTableId: "commentCount",
    tableName: "comments",
    select: "",
  },
  {
    uiTableName: "Comment Content",
    uiTableId: "commentContent",
    tableName: "comments",
    select: "",
  },
];
