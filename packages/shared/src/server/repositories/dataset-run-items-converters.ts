import { DatasetRunItemDomain } from "../../domain/dataset-run-items";
import { convertDateToAnalyticsDateTime } from "./analytics";
import { parseMetadataCHRecordToDomain } from "../utils/metadata_conversion";
import { parseDorisUTCDateTimeFormat } from "./doris";
import {
  DatasetRunItemRecordReadType,
  DatasetRunItemRecord,
} from "./definitions";

export const convertToDatasetRunMetrics = (row: any) => {
  return {
    id: row.dataset_run_id,
    projectId: row.project_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    name: row.datasetRunName,
    description: row.datasetRunDescription ?? "",
    metadata: row.datasetRunMetadata,
    countRunItems: row.count_run_items,
    avgTotalCost: undefined,
    totalCost: undefined,
    avgLatency: undefined,
    scores: undefined,
    datasetId: row.dataset_id,
  };
};

export const convertDatasetRunItemDomainToDoris = (
  datasetRunItem: DatasetRunItemDomain,
): DatasetRunItemRecordReadType => {
  return {
    id: datasetRunItem.id,
    project_id: datasetRunItem.projectId,
    trace_id: datasetRunItem.traceId,
    observation_id: datasetRunItem.observationId,
    dataset_id: datasetRunItem.datasetId,
    dataset_run_id: datasetRunItem.datasetRunId,
    dataset_run_name: datasetRunItem.datasetRunName,
    dataset_run_description: datasetRunItem.datasetRunDescription,
    dataset_run_metadata: datasetRunItem.datasetRunMetadata as Record<
      string,
      string
    >,
    dataset_item_id: datasetRunItem.datasetItemId,
    dataset_item_input: datasetRunItem.datasetItemInput as string,
    dataset_item_expected_output:
      datasetRunItem.datasetItemExpectedOutput as string,
    dataset_item_metadata: datasetRunItem.datasetItemMetadata as Record<
      string,
      string
    >,
    created_at: convertDateToAnalyticsDateTime(datasetRunItem.createdAt),
    updated_at: convertDateToAnalyticsDateTime(datasetRunItem.updatedAt),
    event_ts: convertDateToAnalyticsDateTime(new Date()),
    is_deleted: 0,
    dataset_run_created_at: convertDateToAnalyticsDateTime(
      datasetRunItem.datasetRunCreatedAt,
    ),
    error: datasetRunItem.error,
  };
};

// Function overloads for clean type discrimination
export function convertDatasetRunItemDorisToDomain(
  row: DatasetRunItemRecord<true>,
): DatasetRunItemDomain<true>;
export function convertDatasetRunItemDorisToDomain(
  row: DatasetRunItemRecord<false>,
): DatasetRunItemDomain<false>;
export function convertDatasetRunItemDorisToDomain<
  WithIO extends boolean = true,
>(row: DatasetRunItemRecord<WithIO>): DatasetRunItemDomain<WithIO> {
  const baseConversion = {
    id: row.id,
    projectId: row.project_id,
    traceId: row.trace_id,
    observationId: row.observation_id ?? null,
    datasetRunId: row.dataset_run_id,
    datasetRunName: row.dataset_run_name,
    datasetRunDescription: row.dataset_run_description ?? null,
    datasetRunCreatedAt: parseDorisUTCDateTimeFormat(
      row.dataset_run_created_at,
    ),
    datasetItemId: row.dataset_item_id,
    datasetItemVersion: row.dataset_item_version
      ? parseDorisUTCDateTimeFormat(row.dataset_item_version)
      : null,
    createdAt: parseDorisUTCDateTimeFormat(row.created_at),
    updatedAt: parseDorisUTCDateTimeFormat(row.updated_at),
    datasetId: row.dataset_id,
    error: row.error ?? null,
  };

  // Check if row has IO fields at runtime, typescript does not support conditional types without runtime checks
  if ("dataset_item_input" in row) {
    return {
      ...baseConversion,
      datasetRunMetadata:
        parseMetadataCHRecordToDomain((row as any).dataset_run_metadata) ??
        null,
      datasetItemInput: (row as any).dataset_item_input,
      datasetItemExpectedOutput: (row as any).dataset_item_expected_output,
      datasetItemMetadata: parseMetadataCHRecordToDomain(
        (row as any).dataset_item_metadata,
      ),
    } as DatasetRunItemDomain<WithIO>;
  } else {
    return baseConversion as DatasetRunItemDomain<WithIO>;
  }
}
