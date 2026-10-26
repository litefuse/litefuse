import type { Job } from "bullmq";

import {
  OtelIngestionQueue,
  QueueJobs,
  QueueName,
  logger,
  recordIncrement,
  type TQueueJobTypes,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { env } from "../../env";

/**
 * DLQ redrive for the otel ingestion shards.
 *
 * Why not plain `job.retry()` (what DlqRetryService uses for the other
 * queues): reprocessJob does NOT reset the attempts counter — after the
 * first redrive `attemptsMade (6) + 1 < attempts (6)` is false, so every
 * later failure skips the whole backoff envelope and bounces straight back
 * to failed. One bare attempt per redrive cycle is no recovery envelope at
 * all. Instead: remove + re-add the SAME envelope under the
 * SAME jobId — attempts start fresh, the first-enqueue `data.timestamp`
 * (age-guard input) and the group identity (jobId = groupId → load label)
 * are preserved.
 *
 * Two guards decide poison instead of redrive:
 *   - AGE: older than the FE label retention window → the dedup label is
 *     purged, a blind replay would DOUBLE-LOAD → reconciliation path only.
 *   - REDRIVE COUNT: > max redrives → deterministic failure (poison group).
 * A poisoned job leaves automatic redrive ONLY after its fileKeys are
 * durably written to the Postgres poison ledger (otherwise
 * removeOnFail's age eviction eventually evaporates the only pointer to the
 * unprocessed files). PG write fails → job stays in failed → retried next
 * cycle.
 */

export type OtelRedriveDecision =
  | { action: "redrive"; redrives: number }
  | { action: "poison"; cause: "age" | "redrives-exhausted" };

export const decideOtelRedrive = (params: {
  firstSeenTs: number;
  redrivesSoFar: number;
  now: number;
  labelKeepMs: number;
  maxRedrives: number;
}): OtelRedriveDecision => {
  if (params.now - params.firstSeenTs > params.labelKeepMs) {
    return { action: "poison", cause: "age" };
  }
  if (params.redrivesSoFar >= params.maxRedrives) {
    return { action: "poison", cause: "redrives-exhausted" };
  }
  return { action: "redrive", redrives: params.redrivesSoFar + 1 };
};

type OtelJobData = TQueueJobTypes[QueueName.OtelIngestionQueue];

const describeJob = (data: OtelJobData) => {
  if ("shape" in data.payload) {
    return {
      groupId: data.payload.groupId,
      fileKeys: data.payload.entries.map((e) => e.fileKey),
    };
  }
  return { groupId: null, fileKeys: [data.payload.data.fileKey] };
};

export const redriveOtelFailedJobs = async (): Promise<void> => {
  for (const shard of OtelIngestionQueue.getShardNames()) {
    const queue = OtelIngestionQueue.getInstance({ shardName: shard });
    if (!queue) {
      logger.error(`[OtelDlq] queue instance unavailable for shard ${shard}`);
      continue;
    }
    // Batch cap per cycle: a Doris recovery must not stampede 100k jobs back
    // into wait at once — the rest waits for the next 10-minute cycle.
    const failed = (await queue.getFailed(
      0,
      env.LITEFUSE_OTEL_DLQ_BATCH_LIMIT - 1,
    )) as Job<OtelJobData>[];
    if (failed.length === 0) continue;
    logger.info(
      `[OtelDlq] shard ${shard}: ${failed.length} failed job(s) in this cycle's window`,
    );

    for (const job of failed) {
      try {
        const data = job.data;
        const { groupId, fileKeys } = describeJob(data);
        const firstSeenTs = new Date(data.timestamp).getTime();
        const decision = decideOtelRedrive({
          firstSeenTs,
          redrivesSoFar: data.redrives ?? 0,
          now: Date.now(),
          labelKeepMs: env.LITEFUSE_OTEL_LABEL_KEEP_MS,
          maxRedrives: env.LITEFUSE_OTEL_DLQ_MAX_REDRIVES,
        });

        if (decision.action === "poison") {
          // PG ledger FIRST — only a durable record may release the job from
          // automatic recovery. If this write throws, the job stays in
          // failed and is re-attempted next cycle. Upsert on (shard, jobId):
          // when job.remove() below fails transiently, the next cycle
          // re-classifies the same job — a plain create would then add a
          // duplicate ledger row every 10 minutes until remove succeeds.
          await prisma.otelPoisonJob.upsert({
            where: {
              shardName_jobId: {
                shardName: shard,
                jobId: String(job.id ?? data.id),
              },
            },
            create: {
              shardName: shard,
              jobId: String(job.id ?? data.id),
              groupId,
              fileKeys,
              reason: `${decision.cause}: ${String(job.failedReason ?? "").slice(0, 1000)}`,
              redrives: data.redrives ?? 0,
              firstSeenAt: new Date(firstSeenTs),
            },
            update: {},
          });
          recordIncrement("langfuse.otel_dlq.poison", 1, {
            shard,
            cause: decision.cause,
          });
          logger.error(
            `event=otel_poison_job shard=${shard} jobId=${job.id} groupId=${groupId ?? "-"} cause=${decision.cause} files=${fileKeys.length} — removed from automatic redrive, see otel_poison_jobs ledger`,
          );
          await job.remove();
          continue;
        }

        // Structured lead BEFORE remove: if we crash inside the remove→add
        // window the job identity + fileKeys survive in the logs.
        logger.warn(
          `event=otel_dlq_redrive shard=${shard} jobId=${job.id} groupId=${groupId ?? "-"} redrives=${decision.redrives} files=${fileKeys.length}`,
        );
        const jobId = String(job.id ?? data.id);
        await job.remove();
        await queue.add(
          QueueJobs.OtelIngestionJob,
          { ...data, redrives: decision.redrives },
          // Same jobId: for group jobs this IS the groupId — the identity the
          // load label derives from; replay dedup depends on it.
          { jobId },
        );
        recordIncrement("langfuse.otel_dlq.redrive", 1, { shard });
      } catch (error) {
        logger.error(
          `[OtelDlq] failed to process failed job ${job.id} on ${shard}:`,
          error,
        );
      }
    }
  }

  // Ledger TTL: prune completion-ledger rows past retention. Piggybacks on
  // this 10-minute cycle — an indexed range delete that is a no-op when
  // nothing qualifies; running it from several workers concurrently is
  // harmless (deleteMany is idempotent).
  try {
    const cutoff = new Date(
      Date.now() - env.LITEFUSE_OTEL_LEDGER_RETENTION_DAYS * 24 * 3600 * 1000,
    );
    const pruned = await prisma.otelFileLedger.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (pruned.count > 0) {
      logger.info(
        `[OtelDlq] pruned ${pruned.count} otel_file_ledger row(s) past ${env.LITEFUSE_OTEL_LEDGER_RETENTION_DAYS}d retention`,
      );
    }
  } catch (error) {
    logger.error("[OtelDlq] ledger prune failed", error);
  }
};
