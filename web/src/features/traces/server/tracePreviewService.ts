import { parseMetadataCHRecordToDomain } from "@langfuse/shared";
import {
  convertDateToAnalyticsDateTime,
  queryDoris,
  tableFor,
} from "@langfuse/shared/src/server";
import { tracePreviewKey } from "@/src/features/traces/lib/tracePreview";

type PreviewRecord = {
  id: string;
  preview_day: string;
  input_trim?: string | null;
  output_trim?: string | null;
  metadata?: Record<string, string> | string;
};

/** Project-authorized table previews. Never read full input/output Variants. */
export async function getTracePreviews(params: {
  projectId: string;
  traces: { id: string; timestamp: Date }[];
  includeMetadata: boolean;
}) {
  const { projectId, traces, includeMetadata } = params;
  if (traces.length === 0) return [];

  const timestamps = traces.map(({ timestamp }) => timestamp.getTime());
  const day = 86_400_000;
  const from = new Date(Math.floor(Math.min(...timestamps) / day) * day);
  const to = new Date((Math.floor(Math.max(...timestamps) / day) + 1) * day);
  const queryParams: Record<string, string> = {
    projectId,
    from: convertDateToAnalyticsDateTime(from),
    to: convertDateToAnalyticsDateTime(to),
  };
  const predicate = (items: typeof traces, column: "id" | "trace_id") =>
    items
      .map(({ id, timestamp }, index) => {
        queryParams[`id${index}`] = id;
        queryParams[`day${index}`] = timestamp.toISOString().slice(0, 10);
        return `(${column} = {id${index}: String} AND DATE(start_time) = {day${index}: String})`;
      })
      .join(" OR ");
  const metadata = includeMetadata
    ? ", json_object_flatten(metadata) AS metadata"
    : "";
  const scalarPredicate = predicate(traces, "id");
  const records = await queryDoris<PreviewRecord>({
    query: `SELECT id, CAST(DATE(start_time) AS STRING) AS preview_day, input_trim, output_trim${metadata}
      FROM ${tableFor(projectId, "traces_scalar")}
      WHERE project_id = {projectId: String}
        AND start_time >= {from: DateTime} AND start_time < {to: DateTime}
        AND (${scalarPredicate})`,
    params: { ...queryParams },
    tags: {
      projectId,
      feature: "tracing",
      type: "trace",
      kind: "batch-preview",
    },
  });
  const byKey = new Map(
    records.map((record) => [
      tracePreviewKey({ id: record.id, day: record.preview_day }),
      record,
    ]),
  );
  const references = new Map(
    traces.map(({ id, timestamp }) => {
      const day = timestamp.toISOString().slice(0, 10);
      return [tracePreviewKey({ id, day }), { id, timestamp, day }];
    }),
  );
  const missing = [...references.entries()]
    .filter(([key]) => !byKey.has(key))
    .map(([, reference]) => reference);
  if (missing.length > 0) {
    // Preserve the old compact byId fallback during scalar ingestion lag. One
    // bounded root-span query for all missing IDs, never N individual retries.
    const rootPredicate = predicate(missing, "trace_id");
    const roots = await queryDoris<PreviewRecord>({
      query: `SELECT id, preview_day, input_trim, output_trim${includeMetadata ? ", metadata" : ""}
        FROM (
          SELECT trace_id AS id, CAST(DATE(start_time) AS STRING) AS preview_day, input_trim, output_trim${includeMetadata ? ", metadata" : ""},
            ROW_NUMBER() OVER (PARTITION BY trace_id, DATE(start_time) ORDER BY created_at DESC) AS preview_rank
          FROM ${tableFor(projectId, "spans")}
          WHERE project_id = {projectId: String} AND is_root = 1
            AND start_time >= {from: DateTime} AND start_time < {to: DateTime}
            AND (${rootPredicate})
        ) AS roots WHERE preview_rank = 1`,
      params: { ...queryParams },
      tags: {
        projectId,
        feature: "tracing",
        type: "trace",
        kind: "batch-preview-fallback",
      },
    });
    for (const root of roots)
      byKey.set(tracePreviewKey({ id: root.id, day: root.preview_day }), root);
  }
  // Missing/deleted rows stay absent without failing previews for the page.
  return [...references.entries()].flatMap(([key, { id, day }]) => {
    const record = byKey.get(key);
    return record
      ? [
          {
            id,
            day,
            input: record.input_trim ?? null,
            output: record.output_trim ?? null,
            metadata: includeMetadata
              ? JSON.stringify(
                  parseMetadataCHRecordToDomain(record.metadata ?? {}),
                )
              : undefined,
          },
        ]
      : [];
  });
}
