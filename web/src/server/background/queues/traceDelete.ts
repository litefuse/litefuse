import {
  getCurrentSpan,
  logger,
  shouldSkipTraceDeletionFor,
  type PgBossJobEnvelope,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";

import { processDorisTraceDelete } from "../features/traces/processDorisTraceDelete";
import { processPostgresTraceDelete } from "../features/traces/processPostgresTraceDelete";
import { env } from "@/src/env.mjs";

export type TraceDeletePayload =
  | { projectId: string; traceIds: string[] }
  | { projectId: string; traceId: string };

export const traceDeleteProcessor = async (job: {
  data: PgBossJobEnvelope<TraceDeletePayload>;
}): Promise<void> => {
  const projectId = job.data.payload.projectId;
  const eventTraceIds =
    "traceIds" in job.data.payload
      ? job.data.payload.traceIds
      : [job.data.payload.traceId];

  const span = getCurrentSpan();

  const [toBeDeletedTraces, pendingEventTraceIds] = await Promise.all([
    prisma.pendingDeletion.findMany({
      where: { projectId, object: "trace", isDeleted: false },
      select: { objectId: true },
    }),
    prisma.pendingDeletion.findMany({
      where: {
        projectId,
        object: "trace",
        objectId: { in: eventTraceIds },
      },
    }),
  ]);

  const toBeDeletedEventTraceIds = eventTraceIds.filter(
    (traceId) =>
      !pendingEventTraceIds.some((t) => t.objectId === traceId && t.isDeleted),
  );

  const allTraceIds = Array.from(
    new Set([
      ...toBeDeletedTraces.map((t) => t.objectId),
      ...toBeDeletedEventTraceIds,
    ]),
  );

  if (allTraceIds.length === 0) {
    logger.debug(`No traces to delete for project ${projectId}`);
    return;
  }

  logger.debug(
    `Batch deleting ${allTraceIds.length} traces for project ${projectId}`,
  );

  const traceIdsToDelete = allTraceIds.slice(0, env.LITEFUSE_DELETE_BATCH_SIZE);

  if (span) {
    span.setAttribute("job.computed.totalTraceCount", traceIdsToDelete.length);
    span.setAttribute("job.computed.eventTraceCount", eventTraceIds.length);
    span.setAttribute(
      "job.computed.pendingTraceCount",
      toBeDeletedTraces.length,
    );
  }

  try {
    if (await shouldSkipTraceDeletionFor(projectId, traceIdsToDelete)) {
      return;
    }
    await Promise.all([
      processPostgresTraceDelete(projectId, traceIdsToDelete),
      processDorisTraceDelete(projectId, traceIdsToDelete),
    ]);
    if (toBeDeletedTraces.length > 0) {
      await prisma.pendingDeletion.updateMany({
        where: {
          projectId,
          object: "trace",
          objectId: { in: traceIdsToDelete },
          isDeleted: false,
        },
        data: { isDeleted: true },
      });
    }
    logger.debug(
      `Successfully batch deleted ${allTraceIds.length} traces and marked them as deleted`,
    );
  } catch (error) {
    logger.error(
      `Failed to batch delete traces for project ${projectId}:`,
      error,
    );
    throw error;
  }
};
