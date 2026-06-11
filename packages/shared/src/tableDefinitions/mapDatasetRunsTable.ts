import { UiColumnMappings } from "./types";

export const datasetRunsTableUiColumnDefinitions: UiColumnMappings = [
  {
    uiTableName: "Dataset Run ID",
    uiTableId: "id",
    tableName: "dataset_run_items_rmt",
    select: "drm.dataset_run_id",
  },
  {
    uiTableName: "Created At",
    uiTableId: "createdAt",
    tableName: "dataset_run_items_rmt",
    select: "drm.dataset_run_created_at",
  },
  {
    uiTableName: "Scores (numeric)",
    uiTableId: "agg_scores_avg",
    tableName: "dataset_run_items_rmt",
    select: "sa.scores_avg",
  },
  {
    uiTableName: "Scores (categorical)",
    uiTableId: "agg_score_categories",
    tableName: "dataset_run_items_rmt",
    select: "sa.score_categories",
  },
];
