import { UiColumnMappings } from "./types";

// Make sure to update web/src/features/query/dashboardUiTableToViewMapping.ts if you make changes

export const dashboardColumnDefinitions: UiColumnMappings = [
  {
    uiTableName: "Trace Name",
    uiTableId: "traceName",
    tableName: "traces",
    select: "t.`name`",
  },
  {
    uiTableName: "Tags",
    uiTableId: "traceTags",
    tableName: "traces",
    select: "t.`tags`",
  },
  {
    uiTableName: "Timestamp",
    uiTableId: "timestamp",
    tableName: "traces",
    select: "t.`timestamp`",
  },
  {
    tableName: "scores",
    select: "s.name",
    uiTableId: "scoreName",
    uiTableName: "Score Name",
  },
  {
    tableName: "scores",
    select: "s.timestamp",
    uiTableId: "scoreTimestamp",
    uiTableName: "Score Timestamp",
  },
  {
    tableName: "scores",
    select: "s.source",
    uiTableId: "scoreSource",
    uiTableName: "Score Source",
  },
  {
    tableName: "scores",
    select: "s.data_type",
    uiTableId: "scoreDataType",
    uiTableName: "Scores Data Type",
  },
  {
    tableName: "scores",
    select: "s.`value`",
    uiTableId: "value",
    uiTableName: "value",
  },
  {
    tableName: "observations",
    select: "o.start_time",
    uiTableId: "startTime",
    uiTableName: "Start Time",
  },
  {
    tableName: "observations",
    select: "o.end_time",
    uiTableId: "endTime",
    uiTableName: "End Time",
  },
  {
    tableName: "observations",
    select: "o.`type`",
    uiTableId: "type",
    uiTableName: "Type",
  },
  {
    tableName: "traces",
    select: "t.user_id",
    uiTableId: "userId",
    uiTableName: "User",
  },
  {
    tableName: "traces",
    select: "t.`release`",
    uiTableId: "release",
    uiTableName: "Release",
  },
  {
    tableName: "traces",
    select: "t.version",
    uiTableId: "version",
    uiTableName: "Version",
  },
  {
    tableName: "observations",
    select: "provided_model_name",
    uiTableId: "model",
    uiTableName: "Model",
  },
  {
    tableName: "observations",
    select: "mapKeys(tool_definitions)",
    uiTableId: "toolNames",
    uiTableName: "Tool Names",
  },
  {
    tableName: "traces",
    select: "t.environment",
    uiTableId: "environment",
    uiTableName: "Environment",
  },
];
