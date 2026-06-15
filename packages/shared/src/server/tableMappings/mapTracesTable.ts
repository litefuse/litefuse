import { UiColumnMappings } from "../../tableDefinitions";

export const tracesTableUiColumnDefinitions: UiColumnMappings = [
  {
    uiTableName: "⭐️",
    uiTableId: "bookmarked",
    tableName: "traces",
    select: "t.bookmarked",
  },
  {
    uiTableName: "Level",
    uiTableId: "level",
    tableName: "observations",
    select: "aggregated_level",
    queryPrefix: "o",
  },
  {
    uiTableName: "ID",
    uiTableId: "id",
    tableName: "traces",
    select: "id",
  },
  {
    uiTableName: "Trace ID",
    uiTableId: "traceId",
    tableName: "traces",
    select: "id",
  },
  {
    uiTableName: "Name",
    uiTableId: "name",
    tableName: "traces",
    select: "name",
    queryPrefix: "t",
  },
  {
    // Alias for name - allows traceName filter (used in evals) to work on traces table
    // this happens in the v4 beta if someone filters for traceName in beta mode and then switches back to non-beta
    // TODO: remove after beta v4 is concluded
    uiTableName: "Trace Name",
    uiTableId: "traceName",
    tableName: "traces",
    select: "name",
    queryPrefix: "t",
  },
  {
    uiTableName: "Timestamp",
    uiTableId: "timestamp",
    tableName: "traces",
    select: "timestamp",
    queryPrefix: "t",
  },
  {
    uiTableName: "User ID",
    uiTableId: "userId",
    tableName: "traces",
    select: "user_id",
    queryPrefix: "t",
  },
  {
    uiTableName: "Session ID",
    uiTableId: "sessionId",
    tableName: "traces",
    select: "session_id",
    queryPrefix: "t",
  },
  {
    uiTableName: "Metadata",
    uiTableId: "metadata",
    tableName: "traces",
    select: "metadata",
    queryPrefix: "t",
  },
  {
    uiTableName: "Version",
    uiTableId: "version",
    tableName: "traces",
    select: "version",
    queryPrefix: "t",
  },
  {
    uiTableName: "Release",
    uiTableId: "release",
    tableName: "traces",
    select: "`release`",
    queryPrefix: "t",
  },
  {
    uiTableName: "Environment",
    uiTableId: "environment",
    tableName: "traces",
    select: "environment",
    queryPrefix: "t",
  },
  {
    uiTableName: "Tags",
    uiTableId: "tags",
    tableName: "traces",
    select: "tags",
    queryPrefix: "t",
  },
  {
    uiTableName: "Warning Level Count",
    uiTableId: "warningCount",
    tableName: "observations",
    select: "warning_count",
    queryPrefix: "o",
  },
  {
    uiTableName: "Error Level Count",
    uiTableId: "errorCount",
    tableName: "observations",
    select: "error_count",
    queryPrefix: "o",
  },
  {
    uiTableName: "Default Level Count",
    uiTableId: "defaultCount",
    tableName: "observations",
    select: "default_count",
    queryPrefix: "o",
  },
  {
    uiTableName: "Debug Level Count",
    uiTableId: "debugCount",
    tableName: "observations",
    select: "debug_count",
    queryPrefix: "o",
  },
  {
    uiTableName: "Input Tokens",
    uiTableId: "inputTokens",
    tableName: "observations",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'input') > 0, o.usage_details)))",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Output Tokens",
    uiTableId: "outputTokens",
    tableName: "observations",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'output') > 0, o.usage_details)))",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Total Tokens",
    uiTableId: "totalTokens",
    tableName: "observations",
    select:
      "if(mapExists((k, v) -> (k = 'total'), o.usage_details), o.usage_details['total'], NULL)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Tokens",
    uiTableId: "tokens",
    tableName: "observations",
    select:
      "if(mapExists((k, v) -> (k = 'total'), o.usage_details), o.usage_details['total'], NULL)",
    typeOverwrite: "Decimal64(3)",
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
    uiTableName: "Latency (s)",
    uiTableId: "latency",
    tableName: "observations",
    queryPrefix: "o",
    select: "latency_milliseconds / 1000",
    // If we use the default of Decimal64(12), we cannot filter for more than ~40min due to an overflow
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Input Cost ($)",
    uiTableId: "inputCost",
    tableName: "observations",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'input') > 0, o.cost_details)))",
  },
  {
    uiTableName: "Output Cost ($)",
    uiTableId: "outputCost",
    tableName: "observations",
    select:
      "arraySum(mapValues(mapFilter(x -> positionCaseInsensitive(x.1, 'output') > 0, o.cost_details)))",
  },
  {
    uiTableName: "Total Cost ($)",
    uiTableId: "totalCost",
    tableName: "observations",
    queryPrefix: "o",
    select: "cost_details['total']",
  },
];

export const tracesTableUiColumnDefinitionsForDoris: UiColumnMappings = [
  {
    uiTableName: "⭐️",
    uiTableId: "bookmarked",
    tableName: "traces",
    select: "bookmarked",
    queryPrefix: "t",
  },
  {
    uiTableName: "Level",
    uiTableId: "level",
    tableName: "observations",
    select: "aggregated_level",
    queryPrefix: "os",
  },
  {
    uiTableName: "ID",
    uiTableId: "id",
    tableName: "traces",
    select: "trace_id",
    queryPrefix: "t",
  },
  {
    uiTableName: "Trace ID",
    uiTableId: "traceId",
    tableName: "traces",
    select: "trace_id",
    queryPrefix: "t",
  },
  {
    // The Doris OTel-only model stores every OTel span as one
    // `events_full` row; the per-row `name` column is the *span*'s
    // own name (e.g. the generation name), while `trace_name` is the
    // trace-level name denormalised onto every row by
    // createEventRecord. Filtering by what the UI calls "Name" / "Trace
    // Name" must therefore target `trace_name`. (Upstream langfuse-main
    // has a separate `traces` table where `traces.name` already is the
    // trace name, so the un-Dorisized mapping above selects "name"
    // unchanged; do not touch that block.)
    uiTableName: "Name",
    uiTableId: "name",
    tableName: "traces",
    select: "trace_name",
    queryPrefix: "t",
  },
  {
    // Alias for name - allows traceName filter (used in evals) to work on traces table
    uiTableName: "Trace Name",
    uiTableId: "traceName",
    tableName: "traces",
    select: "trace_name",
    queryPrefix: "t",
  },
  {
    uiTableName: "Timestamp",
    uiTableId: "timestamp",
    tableName: "traces",
    select: "start_time",
    queryPrefix: "t",
  },
  {
    uiTableName: "User ID",
    uiTableId: "userId",
    tableName: "traces",
    select: "user_id",
    queryPrefix: "t",
  },
  {
    uiTableName: "Session ID",
    uiTableId: "sessionId",
    tableName: "traces",
    select: "session_id",
    queryPrefix: "t",
  },
  {
    uiTableName: "Metadata",
    uiTableId: "metadata",
    tableName: "traces",
    select: "metadata",
    queryPrefix: "t",
  },
  {
    uiTableName: "Version",
    uiTableId: "version",
    tableName: "traces",
    select: "version",
    queryPrefix: "t",
  },
  {
    uiTableName: "Release",
    uiTableId: "release",
    tableName: "traces",
    select: "`release`",
    queryPrefix: "t",
  },
  {
    uiTableName: "Environment",
    uiTableId: "environment",
    tableName: "traces",
    select: "environment",
    queryPrefix: "t",
  },
  {
    uiTableName: "Tags",
    uiTableId: "tags",
    tableName: "traces",
    select: "tags",
    queryPrefix: "t",
  },
  {
    uiTableName: "Warning Level Count",
    uiTableId: "warningCount",
    tableName: "observations",
    select: "warning_count",
    queryPrefix: "os",
  },
  {
    uiTableName: "Error Level Count",
    uiTableId: "errorCount",
    tableName: "observations",
    select: "error_count",
    queryPrefix: "os",
  },
  {
    uiTableName: "Default Level Count",
    uiTableId: "defaultCount",
    tableName: "observations",
    select: "default_count",
    queryPrefix: "os",
  },
  {
    uiTableName: "Debug Level Count",
    uiTableId: "debugCount",
    tableName: "observations",
    select: "debug_count",
    queryPrefix: "os",
  },
  {
    uiTableName: "Input Tokens",
    uiTableId: "inputTokens",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%input%', map_values(os.usage_details), map_keys(os.usage_details))), 0)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Output Tokens",
    uiTableId: "outputTokens",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%output%', map_values(os.usage_details), map_keys(os.usage_details))), 0)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Total Tokens",
    uiTableId: "totalTokens",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) = 'total', map_values(os.usage_details), map_keys(os.usage_details))), 0)",
    typeOverwrite: "Decimal64(3)",
  },
  {
    uiTableName: "Tokens",
    uiTableId: "tokens",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) = 'total', map_values(os.usage_details), map_keys(os.usage_details))), 0)",
    typeOverwrite: "Decimal64(3)",
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
    uiTableName: "Latency (s)",
    uiTableId: "latency",
    tableName: "observations",
    select: "latency_milliseconds / 1000",
    typeOverwrite: "Decimal64(3)",
    queryPrefix: "os",
  },
  {
    uiTableName: "Input Cost ($)",
    uiTableId: "inputCost",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%input%', map_values(os.cost_details), map_keys(os.cost_details))), 0)",
  },
  {
    uiTableName: "Output Cost ($)",
    uiTableId: "outputCost",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%output%', map_values(os.cost_details), map_keys(os.cost_details))), 0)",
  },
  {
    uiTableName: "Total Cost ($)",
    uiTableId: "totalCost",
    tableName: "observations",
    select:
      "COALESCE(array_sum(array_filter((v, k) -> lower(k) = 'total', map_values(os.cost_details), map_keys(os.cost_details))), 0)",
  },
];
