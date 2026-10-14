import { z } from "zod/v4";

const observationPreviewReference = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  startTime: z.date(),
});

export const observationBatchPreviewInput = z.object({
  projectId: z.string().min(1),
  observations: z.array(observationPreviewReference).max(1000),
  includeMetadata: z.boolean().default(false),
});

export type ObservationPreviewReference = z.infer<
  typeof observationPreviewReference
>;

export const observationPreviewKey = ({
  id,
  traceId,
  startTime,
}: ObservationPreviewReference) =>
  JSON.stringify([traceId, id, startTime.toISOString()]);

export function getObservationPreviewReferences(
  rows: Array<{ id: string; traceId?: string | null; startTime: Date }>,
): ObservationPreviewReference[] {
  const references = new Map<string, ObservationPreviewReference>();
  for (const row of rows) {
    if (!row.id || !row.traceId || !Number.isFinite(row.startTime.getTime())) {
      continue;
    }
    const reference = {
      id: row.id,
      traceId: row.traceId,
      startTime: row.startTime,
    };
    references.set(observationPreviewKey(reference), reference);
  }
  return [...references.values()];
}
