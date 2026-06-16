import { prisma } from "../db";
import { enqueuePgBossJob } from "./pgboss/pgBoss";
import { QueueJobs, QueueName } from "./queues";
import { logger } from "./logger";
import { env } from "../env";

export interface TraceDeletionProcessorOptions {
  delayMs?: number; // Default from LITEFUSE_TRACE_DELETE_DELAY_MS env var
}

export async function shouldSkipTraceDeletionFor(
  projectId: string,
  traceIds: string[],
): Promise<boolean> {
  // Check if project is in skip list
  if (env.LITEFUSE_TRACE_DELETE_SKIP_PROJECT_IDS.includes(projectId)) {
    logger.info(
      `Skipping trace deletion for project ${projectId} (in skip list). No pending deletions created, no queue job added.`,
      {
        projectId,
        traceIds,
        traceCount: traceIds.length,
        skipReason: "LITEFUSE_TRACE_DELETE_SKIP_PROJECT_IDS",
      },
    );

    return true;
  }

  // Check if project still exists (might have been deleted)
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });

  if (!project) {
    logger.info(
      `Skipping trace deletion for project ${projectId} (project no longer exists). No pending deletions created, no queue job added.`,
      {
        projectId,
        traceIds,
        traceCount: traceIds.length,
        skipReason: "PROJECT_NOT_FOUND",
      },
    );

    return true;
  }

  return false;
}

/**
 * Efficient trace deletion processor that batches deletions for better performance.
 *
 * This function:
 * 1. Creates a record in the pending_deletions table for each trace
 * 2. Sends a deletion event to the queue with a configurable delay
 * 3. The worker will batch delete all pending traces from Doris
 * 4. Sets the is_deleted flag to true after successful deletion
 *
 * @param projectId - The project ID
 * @param traceIds - Array of trace IDs to delete
 * @param options - Configuration options including delay
 */
export async function traceDeletionProcessor(
  projectId: string,
  traceIds: string[],
  options: TraceDeletionProcessorOptions = {},
): Promise<void> {
  const { delayMs = env.LITEFUSE_TRACE_DELETE_DELAY_MS } = options;

  if (traceIds.length === 0) {
    logger.warn("traceDeletionProcessor called with empty traceIds array", {
      projectId,
    });
    return;
  }

  logger.info(
    `Processing trace deletion for ${traceIds.length} traces in project ${projectId}`,
    {
      projectId,
      traceIds,
      delayMs,
    },
  );

  if (await shouldSkipTraceDeletionFor(projectId, traceIds)) {
    return; // Early return - don't create pending_deletions or queue job
  }

  try {
    // Create pending deletion records for all traces
    await prisma.pendingDeletion.createMany({
      data: traceIds.map((traceId) => ({
        projectId,
        object: "trace",
        objectId: traceId,
        isDeleted: false,
      })),
      skipDuplicates: true, // Avoid conflicts if trace is already pending deletion
    });

    // Enqueue the delete via pg-boss with the same delay semantics the
    // old BullMQ queue had (delayMs → startAfter seconds).
    await enqueuePgBossJob(
      QueueName.TraceDelete,
      QueueJobs.TraceDelete,
      {
        projectId,
        traceIds,
      },
      {
        startAfter: Math.max(1, Math.ceil(delayMs / 1000)),
      },
    );
  } catch (error) {
    logger.error(`Failed to process trace deletion for project ${projectId}`, {
      projectId,
      traceIds,
      error,
    });
    throw error;
  }
}
