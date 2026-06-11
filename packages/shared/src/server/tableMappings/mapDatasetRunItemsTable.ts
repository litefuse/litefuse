import { UiColumnMappings } from "../../tableDefinitions";
import { DatasetRunItemDomain } from "../../domain/dataset-run-items";

export const datasetRunItemsTableUiColumnDefinitions: UiColumnMappings = [
  {
    uiTableName: "Dataset Run ID",
    uiTableId: "datasetRunId",
    tableName: "dataset_run_items_rmt",
    select: "dri.`dataset_run_id`",
  },
  {
    uiTableName: "Dataset Run IDs",
    uiTableId: "datasetRunItemRunIds",
    tableName: "dataset_run_items_rmt",
    select: "dri.`dataset_run_id`",
  },
  {
    uiTableName: "Created At",
    uiTableId: "createdAt",
    tableName: "dataset_run_items_rmt",
    select: "dri.`created_at`",
  },
  {
    uiTableName: "Event Timestamp",
    uiTableId: "eventTs",
    tableName: "dataset_run_items_rmt",
    select: "dri.`event_ts`",
  },
  {
    uiTableName: "Dataset Item ID",
    uiTableId: "datasetItemId",
    tableName: "dataset_run_items_rmt",
    select: "dri.`dataset_item_id`",
  },
  {
    uiTableName: "Dataset",
    uiTableId: "datasetId",
    tableName: "dataset_run_items_rmt",
    select: "dri.`dataset_id`",
  },
  {
    uiTableName: "Scores (numeric)",
    uiTableId: "agg_scores_avg",
    tableName: "scores",
    select: "sa.scores_avg",
  },
  {
    uiTableName: "Scores (categorical)",
    uiTableId: "agg_score_categories",
    tableName: "scores",
    select: "sa.score_categories",
  },
];

export const mapDatasetRunItemFilterColumn = (
  dataset: Pick<DatasetRunItemDomain, "id" | "datasetId">,
  column: string,
): unknown => {
  const columnDef = datasetRunItemsTableUiColumnDefinitions.find(
    (col) =>
      col.uiTableId === column ||
      col.uiTableName === column ||
      col.select === column,
  );
  if (!columnDef) {
    throw new Error(`Unhandled column for dataset run items filter: ${column}`);
  }
  switch (columnDef.uiTableId) {
    case "id":
      return dataset.id;
    case "datasetId":
      return dataset.datasetId;
    default:
      throw new Error(
        `Unhandled column in dataset run items filter mapping: ${column}`,
      );
  }
};
