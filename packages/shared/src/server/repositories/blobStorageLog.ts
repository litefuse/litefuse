import { BlobStorageFileRefRecordReadType } from "./definitions";
// Add Doris imports
import { convertDateToAnalyticsDateTime } from "./analytics";
import { queryDoris, queryDorisStream } from "./doris";
import { tableFor } from "../doris/tableRouting";

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
      -- Trace/observation entity ids come from the per-project event table family: the
      -- legacy v3 \`traces\`/\`observations\` tables receive NO writes under the
      -- OTel-only contract, so reading them here returned empty sets and blob
      -- cleanup silently skipped every trace/observation file. Trace entities
      -- are the scalar rows (one per trace); observation entities are the
      -- trace's span ids from the event rows (the root span id doubles as an
      -- entity id superset — non-matching ids simply find no log rows in the
      -- EXISTS semi-join).
      with filtered_traces as (
        select distinct
          id as entity_id,
          project_id as project_id,
          'trace' as entity_type
        from ${tableFor(projectId, "traces_scalar")}
        where project_id = {projectId: String}
          and id in ({traceIds: Array(String)})
      ), filtered_observations as (
        select distinct
          span_id as entity_id,
          project_id as project_id,
          'observation' as entity_type
        from ${tableFor(projectId, "spans")}
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
