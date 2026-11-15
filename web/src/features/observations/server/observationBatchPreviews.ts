import { parseMetadataCHRecordToDomain } from "@langfuse/shared";
import {
  convertDateToAnalyticsDateTime,
  parseDorisUTCDateTimeFormat,
  queryDoris,
  tableFor,
} from "@langfuse/shared/src/server";
import {
  getObservationPreviewReferences,
  type ObservationPreviewReference,
} from "@/src/features/observations/lib/observationBatchPreview";
import { stringifyMetadata } from "@/src/utils/clientSideDomainTypes";

/** Compact list previews for an already-authorized project. Never read full IO. */
export async function getObservationBatchPreviews({
  projectId,
  observations,
  includeMetadata = false,
}: {
  projectId: string;
  observations: ObservationPreviewReference[];
  includeMetadata?: boolean;
}) {
  const references = getObservationPreviewReferences(observations);
  if (references.length === 0) return [];

  const timestamps = references.map((row) => row.startTime.getTime());
  const params: Record<string, unknown> = {
    projectId,
    minStartTime: convertDateToAnalyticsDateTime(
      new Date(Math.min(...timestamps)),
    ),
    maxStartTime: convertDateToAnalyticsDateTime(
      new Date(Math.max(...timestamps)),
    ),
  };
  // Keep identity tuples together: independent IN lists admit crossed pairs.
  const identities = references.map((row, index) => {
    params[`traceId${index}`] = row.traceId;
    params[`id${index}`] = row.id;
    params[`startTime${index}`] = convertDateToAnalyticsDateTime(row.startTime);
    return `(trace_id = {traceId${index}: String} AND span_id = {id${index}: String} AND start_time = {startTime${index}: DateTime64(3)})`;
  });

  const rows = await queryDoris<{
    id: string;
    trace_id: string;
    start_time: string;
    input_trim: string | null;
    output_trim: string | null;
    metadata?: string | Record<string, string> | null;
  }>({
    query: `
      SELECT id, trace_id, start_time, input_trim, output_trim${includeMetadata ? ", metadata" : ""}
      FROM (
        SELECT span_id AS id, trace_id, start_time, input_trim, output_trim,
          ${includeMetadata ? "json_object_flatten(metadata) AS metadata," : ""}
          ROW_NUMBER() OVER (
            PARTITION BY trace_id, span_id, start_time
            ORDER BY created_at DESC
          ) AS preview_rank
        FROM ${tableFor(projectId, "spans")}
        WHERE project_id = {projectId: String}
          AND start_time >= {minStartTime: DateTime64(3)}
          AND start_time <= {maxStartTime: DateTime64(3)}
          AND (${identities.join(" OR ")})
      ) previews
      WHERE preview_rank = 1
    `,
    params,
    tags: {
      feature: "tracing",
      type: "observation",
      kind: "batchPreviews",
      projectId,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    traceId: row.trace_id,
    startTime: parseDorisUTCDateTimeFormat(row.start_time),
    input: row.input_trim ?? null,
    output: row.output_trim ?? null,
    metadata: includeMetadata
      ? stringifyMetadata(parseMetadataCHRecordToDomain(row.metadata ?? {}))
      : undefined,
  }));
}
