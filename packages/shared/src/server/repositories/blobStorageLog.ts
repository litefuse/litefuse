import { BlobStorageFileRefRecordReadType } from "./definitions";
// Add Doris imports
import { convertDateToAnalyticsDateTime } from "./analytics";
import { queryDoris, queryDorisStream } from "./doris";

export const getBlobStorageByProjectAndEntityId = async (
  projectId: string,
  entityType: string,
  entityId: string,
): Promise<BlobStorageFileRefRecordReadType[]> => {
  const query = `
      select *
      from blob_storage_file_log
      where project_id = {projectId: String}
      and entity_type = {entityType: String}
      and entity_id = {entityId: String}
    `;

  return queryDoris<BlobStorageFileRefRecordReadType>({
    query,
    params: {
      projectId,
      entityType,
      entityId,
    },
    tags: {
      feature: "eventLog",
      kind: "byID",
      projectId,
    },
  });
};

export const getBlobStorageByProjectId = (
  projectId: string,
): AsyncGenerator<BlobStorageFileRefRecordReadType> => {
  const query = `
      select *
      from blob_storage_file_log
      where project_id = {projectId: String}
    `;

  return queryDorisStream<BlobStorageFileRefRecordReadType>({
    query,
    params: {
      projectId,
    },
    tags: {
      feature: "eventLog",
      kind: "list",
      projectId,
    },
  });
};

export const getBlobStorageByProjectIdBeforeDate = (
  projectId: string,
  beforeDate: Date,
): AsyncGenerator<BlobStorageFileRefRecordReadType> => {
  const query = `
      select *
      from blob_storage_file_log
      where project_id = {projectId: String}
      and created_at <= {beforeDate: DateTime}
    `;

  return queryDorisStream<BlobStorageFileRefRecordReadType>({
    query,
    params: {
      projectId,
      beforeDate: convertDateToAnalyticsDateTime(beforeDate),
    },
    tags: {
      feature: "eventLog",
      kind: "list",
      projectId,
    },
  });
};

export const getBlobStorageByProjectIdAndEntityIds = (
  projectId: string,
  entityType: "observation" | "trace" | "score",
  entityIds: string[],
): AsyncGenerator<BlobStorageFileRefRecordReadType> => {
  const query = `
      select *
      from blob_storage_file_log
      where project_id = {projectId: String}
        and entity_type = {entityType: String}
        and entity_id in ({entityIds: Array(String)})
    `;

  return queryDorisStream<BlobStorageFileRefRecordReadType>({
    query,
    params: {
      projectId,
      entityType,
      entityIds,
    },
    tags: {
      feature: "eventLog",
      kind: "list",
      projectId,
    },
  });
};

export const getBlobStorageByProjectIdAndTraceIds = (
  projectId: string,
  traceIds: string[],
): AsyncGenerator<BlobStorageFileRefRecordReadType> => {
  const query = `
      with filtered_traces as (
        select distinct
          id as entity_id,
          project_id as project_id,
          'trace' as entity_type
        from traces
        where project_id = {projectId: String}
          and id in ({traceIds: Array(String)})
      ), filtered_observations as (
        select distinct
          id as entity_id,
          project_id as project_id,
          'observation' as entity_type
        from observations
        where project_id = {projectId: String}
          and trace_id in ({traceIds: Array(String)})
      ), filtered_scores as (
        select distinct
          id as entity_id,
          project_id as project_id,
          'score' as entity_type
        from scores
        where project_id = {projectId: String}
          and trace_id in ({traceIds: Array(String)})
      ), filtered_events as (
        select *
        from filtered_traces
        union all
        select *
        from filtered_observations
        union all
        select *
        from filtered_scores
      )

      -- Use EXISTS for semi-join in Doris
      select el.*
      from blob_storage_file_log el
      where el.project_id = {projectId: String}
      and exists (
        select 1
        from filtered_events fe
        where el.project_id = fe.project_id 
        and el.entity_id = fe.entity_id 
        and el.entity_type = fe.entity_type
      )
    `;

  return queryDorisStream<BlobStorageFileRefRecordReadType>({
    query,
    params: {
      projectId,
      traceIds,
    },
    tags: {
      feature: "eventLog",
      kind: "list",
      projectId,
    },
  });
};
