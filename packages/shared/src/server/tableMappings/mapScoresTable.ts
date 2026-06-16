import { UiColumnMappings } from "../../tableDefinitions";

export const scoresTableUiColumnDefinitions: UiColumnMappings = [
  {
    uiTableName: "ID",
    uiTableId: "id",
    tableName: "scores",
    select: "s.id",
  },
  {
    uiTableName: "Timestamp",
    uiTableId: "timestamp",
    tableName: "scores",
    select: "s.timestamp",
  },
  {
    uiTableName: "Environment",
    uiTableId: "environment",
    tableName: "scores",
    select: "s.environment",
  },
  {
    uiTableName: "Trace ID",
    uiTableId: "traceId",
    tableName: "scores",
    select: "s.trace_id",
  },
  {
    uiTableName: "Observation ID",
    uiTableId: "observationId",
    tableName: "scores",
    select: "s.observation_id",
  },
  {
    uiTableName: "Session ID",
    uiTableId: "sessionId",
    tableName: "scores",
    select: "s.session_id",
  },
  {
    uiTableName: "Name",
    uiTableId: "name",
    tableName: "scores",
    select: "s.name",
  },
  {
    uiTableName: "Value",
    uiTableId: "value",
    tableName: "scores",
    select: "s.value",
  },
  {
    uiTableName: "Source",
    uiTableId: "source",
    tableName: "scores",
    select: "s.source",
  },
  {
    uiTableName: "Comment",
    uiTableId: "comment",
    tableName: "scores",
    select: "s.comment",
  },
  {
    uiTableName: "Author User ID",
    uiTableId: "authorUserId",
    tableName: "scores",
    select: "s.author_user_id",
  },
  {
    uiTableName: "Data Type",
    uiTableId: "dataType",
    tableName: "scores",
    select: "s.data_type",
  },
  {
    uiTableName: "String Value",
    uiTableId: "stringValue",
    tableName: "scores",
    select: "s.string_value",
  },
  {
    uiTableName: "Metadata",
    uiTableId: "metadata",
    tableName: "scores",
    select: "metadata",
  },
  {
    uiTableName: "Trace Name",
    uiTableId: "traceName",
    tableName: "traces",
    select: "t.name",
  },
  {
    uiTableName: "User ID",
    uiTableId: "userId",
    tableName: "traces",
    select: "t.user_id",
  },
  {
    uiTableName: "Trace Tags",
    uiTableId: "trace_tags",
    tableName: "traces",
    select: "t.tags",
  },
];

/**
 * v4 column definitions for scores table — trace columns reference the traces
 * CTE built from a flat EventsQueryBuilder. The CTE is joined as alias "e".
 */
export const scoresTableUiColumnDefinitionsFromEvents: UiColumnMappings = [
  // All scores-native columns are identical to v3
  ...scoresTableUiColumnDefinitions.filter((c) => c.tableName === "scores"),
  {
    uiTableName: "Trace Name",
    uiTableId: "traceName",
    tableName: "traces",
    select: "name",
    queryPrefix: "e",
  },
  {
    uiTableName: "User ID",
    uiTableId: "userId",
    tableName: "traces",
    select: "user_id",
    queryPrefix: "e",
  },
  {
    uiTableName: "Trace Tags",
    uiTableId: "trace_tags",
    tableName: "traces",
    select: "tags",
    queryPrefix: "e",
  },
];
