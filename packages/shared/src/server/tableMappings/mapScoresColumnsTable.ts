import { UiColumnMappings } from "../../tableDefinitions";

export const scoresColumnsTableUiColumnDefinitions: UiColumnMappings = [
  // scores native columns
  {
    uiTableName: "Timestamp",
    uiTableId: "timestamp",
    tableName: "scores",
    select: "timestamp",
  },
  {
    uiTableName: "Session ID",
    uiTableId: "sessionId",
    tableName: "scores",
    select: "s.`session_id`",
  },
  {
    uiTableName: "Dataset Run IDs",
    uiTableId: "datasetRunIds",
    tableName: "scores",
    select: "s.`dataset_run_id`",
  },
  {
    uiTableName: "Observation ID",
    uiTableId: "observationId",
    tableName: "scores",
    select: "s.`observation_id`",
  },
  {
    uiTableName: "Trace ID",
    uiTableId: "traceId",
    tableName: "scores",
    select: "s.`trace_id`",
  },
  // require join of scores with dataset_run_items_rmt via trace_id and project_id
  {
    uiTableName: "Dataset Run Item Run IDs",
    uiTableId: "datasetRunItemRunIds",
    tableName: "dataset_run_items_rmt",
    select: "dri.`dataset_run_id`",
  },
  {
    uiTableName: "Dataset ID",
    uiTableId: "datasetId",
    tableName: "dataset_run_items_rmt",
    select: "dri.`dataset_id`",
  },
  {
    uiTableName: "Dataset Item IDs",
    uiTableId: "datasetItemIds",
    tableName: "dataset_run_items_rmt",
    select: "dri.`dataset_item_id`",
  },
];

// Doris-specific column definitions for scores columns table.
// Uses plain column names without double-quoted identifiers (which Doris doesn't support).
// datasetRunItemRunIds / datasetId / datasetItemIds require a JOIN with
// dataset_run_items_rmt on (project_id, trace_id); scores.dataset_run_id is only
// populated for scores recorded against a dataset run directly, not for EVAL scores.
export const scoresColumnsTableUiColumnDefinitionsForDoris: UiColumnMappings = [
  {
    uiTableName: "Timestamp",
    uiTableId: "timestamp",
    tableName: "scores",
    select: "timestamp",
    queryPrefix: "s",
  },
  {
    uiTableName: "Session ID",
    uiTableId: "sessionId",
    tableName: "scores",
    select: "session_id",
    queryPrefix: "s",
  },
  {
    uiTableName: "Dataset Run IDs",
    uiTableId: "datasetRunIds",
    tableName: "scores",
    select: "dataset_run_id",
    queryPrefix: "s",
  },
  {
    uiTableName: "Observation ID",
    uiTableId: "observationId",
    tableName: "scores",
    select: "observation_id",
    queryPrefix: "s",
  },
  {
    uiTableName: "Trace ID",
    uiTableId: "traceId",
    tableName: "scores",
    select: "trace_id",
    queryPrefix: "s",
  },
  {
    uiTableName: "Dataset Run Item Run IDs",
    uiTableId: "datasetRunItemRunIds",
    tableName: "dataset_run_items_rmt",
    select: "dataset_run_id",
    queryPrefix: "dri",
  },
  {
    uiTableName: "Dataset ID",
    uiTableId: "datasetId",
    tableName: "dataset_run_items_rmt",
    select: "dataset_id",
    queryPrefix: "dri",
  },
  {
    uiTableName: "Dataset Item IDs",
    uiTableId: "datasetItemIds",
    tableName: "dataset_run_items_rmt",
    select: "dataset_item_id",
    queryPrefix: "dri",
  },
];
