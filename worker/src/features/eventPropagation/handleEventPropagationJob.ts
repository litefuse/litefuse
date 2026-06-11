import {
  queryDoris,
  commandDoris,
  getCurrentSpan,
  logger,
  QueueName,
  TQueueJobTypes,
  traceException,
  redis,
  recordGauge,
} from "@langfuse/shared/src/server";
import { Job } from "bullmq";
import { env } from "../../env";

const LAST_PROCESSED_PARTITION_KEY =
  "langfuse:event-propagation:last-processed-partition";

/**
 * Retire sentinel used by handleEventPropagationJob below. Defined as a
 * function so TypeScript does not constant-fold the value and mark the
 * rest of the function body unreachable — we want type-checking of the
 * preserved-for-reference original body to continue working.
 */
const isRetired = (): boolean => true;

/**
 * Get the last processed partition timestamp from Redis.
 * Returns null if no partition has been processed yet or if Redis is unavailable.
 */
export const getLastProcessedPartition = async (): Promise<string | null> => {
  try {
    return await redis!.get(LAST_PROCESSED_PARTITION_KEY);
  } catch (error) {
    logger.error("[DUAL WRITE] Failed to get last processed partition", error);
    return null;
  }
};

/**
 * Update the last processed partition timestamp in Redis.
 * This is called after successfully processing a partition.
 */
export const updateLastProcessedPartition = async (
  partition: string,
): Promise<void> => {
  try {
    await redis!.set(LAST_PROCESSED_PARTITION_KEY, partition);
    logger.info(
      `[DUAL WRITE] Updated last processed partition to ${partition}`,
    );
  } catch (error) {
    logger.error(
      "[DUAL WRITE] Failed to update last processed partition",
      error,
    );
    // Don't throw - allow processing to continue
  }
};

/**
 * Processes partitions from observations_batch_staging table and propagates
 * events to the events table. Uses cursor-based sequential processing to track
 * the last processed partition and always processes the next partition in order.
 * Relies on table TTL for partition cleanup instead of explicit DROP PARTITION.
 *
 * NOTE (master events_full migration): This job is **retired**. It targeted an
 * intermediate langfuse-main v4 design (observations_batch_staging → events
 * staging → events_full propagation) that langfuse-main has since abandoned —
 * spans are now written directly to events_full via OTel ingestion +
 * IngestionService.writeEventRecord. Neither observations_batch_staging nor
 * the legacy `events` table exists in this fork. The function body below is
 * preserved as reference and never executes; the BullMQ Processor still
 * invokes it as a no-op so the queue plumbing stays intact.
 */
export const handleEventPropagationJob = async (
  job: Job<TQueueJobTypes[QueueName.EventPropagationQueue]>,
) => {
  getCurrentSpan()?.setAttribute(
    "messaging.bullmq.job.input.jobId",
    job.data.id,
  );

  // Retired: see header comment. events_full is populated directly by the
  // OTel ingestion path (IngestionService.writeEventRecord), so the
  // partition-by-partition staging propagation below is no longer load-
  // bearing. The retire check goes through a function call (isRetired)
  // so TypeScript does not constant-fold it and mark the rest of the
  // body unreachable — that's how the original code stays type-checked
  // while never executing.
  if (isRetired()) {
    logger.info(
      "[event-propagation] handler is retired (no-op); events_full is now written directly via OTel ingestion",
    );
    return;
  }

  if (env.LITEFUSE_EXPERIMENT_EARLY_EXIT_EVENT_BATCH_JOB === "true") {
    logger.info(
      "[DUAL WRITE] Early exit for event propagation job due to experiment flag",
    );
    return;
  }

  try {
    // Step 1: Get the last processed partition from Redis and find the next one to process
    const lastProcessedPartition = await getLastProcessedPartition();
    logger.info(
      `[DUAL WRITE] Last processed partition: ${lastProcessedPartition ?? "none"}`,
    );

    // Track delay based on the Redis key so we have a reference even if no processing happens
    if (lastProcessedPartition) {
      const lastPartitionTime = new Date(lastProcessedPartition).getTime();
      if (!isNaN(lastPartitionTime)) {
        const delaySeconds = (Date.now() - lastPartitionTime) / 1000;
        recordGauge(
          "langfuse.event_propagation.last_processed_partition_delay_seconds",
          delaySeconds,
        );
      }
    }

    // Query for observation batches older than the delay threshold
    // Doris doesn't have system.parts, so we query observations_batch_staging directly with time-based filtering
    const delayMinutes =
      env.LITEFUSE_EXPERIMENT_EVENT_PROPAGATION_PARTITION_DELAY_MINUTES;
    const partitions = await queryDoris<{ partition: string }>({
      query: `
        SELECT DATE_FORMAT(start_time, '%Y-%m-%d %H:00:00') as partition
        FROM observations_batch_staging
        WHERE start_time < DATE_SUB(NOW(), INTERVAL ${delayMinutes} MINUTE)
          ${lastProcessedPartition ? `AND start_time > {lastProcessedPartition: String}` : ""}
        GROUP BY partition
        ORDER BY partition ASC
        LIMIT 1
      `,
      params: lastProcessedPartition ? { lastProcessedPartition } : undefined,
      tags: {
        feature: "ingestion",
        operation_name: "getNextPartition",
      },
    });

    recordGauge(
      "langfuse.event_propagation.partition_backlog",
      partitions.length,
    );

    if (partitions.length === 0) {
      logger.info(
        `[DUAL WRITE] No partitions available for processing (last processed: ${lastProcessedPartition ?? "none"})`,
      );
      return;
    }

    const partitionToProcess = partitions[0].partition;
    logger.info(
      `[DUAL WRITE] Processing partition ${partitionToProcess} for events table fill`,
    );

    // Step 2: Join observations_batch_staging with traces and insert into events
    // Use a time window for traces to limit the join scope
    // If clients send us an observation_start_time that is smaller than a previously received start_time
    // for the same span, this may create duplicates in the new events table. Deduplicating in this query
    // will significantly affect run-time. This may be an accepted degradation and we test the outcome
    // to check the likelihood of this happening in practice.
    // NOTE: This query was rewritten for Doris. The ClickHouse version used system.parts, groupUniqArray,
    // arrayJoin, map functions, and other ClickHouse-specific features that don't exist in Doris.
    await commandDoris({
      query: `
        INSERT INTO events (
          project_id,
          trace_id,
          span_id,
          parent_span_id,
          start_time,
          end_time,
          name,
          type,
          environment,
          version,
          release,
          tags,
          public,
          bookmarked,
          trace_name,
          user_id,
          session_id,
          level,
          status_message,
          completion_start_time,
          prompt_id,
          prompt_name,
          prompt_version,
          model_id,
          provided_model_name,
          model_parameters,
          provided_usage_details,
          usage_details,
          provided_cost_details,
          cost_details,
          usage_pricing_tier_id,
          usage_pricing_tier_name,
          tool_definitions,
          tool_calls,
          tool_call_names,
          input,
          output,
          metadata,
          metadata_names,
          metadata_raw_values,
          source,
          blob_storage_file_path,
          event_bytes,
          created_at,
          updated_at,
          event_ts,
          is_deleted
        )
        SELECT
          obs.project_id,
          obs.trace_id,
          obs.id AS span_id,
          CASE
            WHEN obs.id = CONCAT('t-', obs.trace_id) THEN ''
            ELSE COALESCE(obs.parent_observation_id, CONCAT('t-', obs.trace_id))
          END AS parent_span_id,
          obs.start_time,
          obs.end_time,
          obs.name,
          obs.type,
          obs.environment,
          COALESCE(obs.version, t.version) as version,
          COALESCE(t.release, '') as release,
          t.tags as tags,
          t.public as public,
          IF(obs.parent_observation_id IS NULL OR obs.parent_observation_id = '', t.bookmarked, FALSE) AS bookmarked,
          t.name AS trace_name,
          COALESCE(t.user_id, '') AS user_id,
          COALESCE(t.session_id, '') AS session_id,
          obs.level,
          COALESCE(obs.status_message, '') AS status_message,
          obs.completion_start_time,
          obs.prompt_id,
          obs.prompt_name,
          obs.prompt_version,
          obs.internal_model_id AS model_id,
          obs.provided_model_name,
          COALESCE(obs.model_parameters, '{}'),
          obs.provided_usage_details,
          obs.usage_details,
          obs.provided_cost_details,
          obs.cost_details,
          obs.usage_pricing_tier_id,
          obs.usage_pricing_tier_name,
          obs.tool_definitions,
          obs.tool_calls,
          obs.tool_call_names,
          COALESCE(obs.input, '') AS input,
          COALESCE(obs.output, '') AS output,
          obs.metadata,
          JSON_KEYS(obs.metadata) AS metadata_names,
          JSON_VALUES(obs.metadata) AS metadata_raw_values,
          IF(JSON_CONTAINS(obs.metadata, 'resourceAttributes'), 'otel-dual-write', 'ingestion-api-dual-write') AS source,
          '' AS blob_storage_file_path,
          0 AS event_bytes,
          obs.created_at,
          obs.updated_at,
          obs.event_ts,
          obs.is_deleted
        FROM observations_batch_staging obs
        LEFT JOIN traces t
        ON obs.project_id = t.project_id AND obs.trace_id = t.id
        WHERE obs.start_time >= DATE_SUB(NOW(), INTERVAL ${delayMinutes} MINUTE)
          AND obs.start_time < DATE_ADD(DATE_FORMAT(obs.start_time, '%Y-%m-%d %H:00:00'), INTERVAL 1 HOUR)
      `,
      tags: {
        feature: "ingestion",
        partition: partitionToProcess,
        operation_name: "propagateObservationsToEvents",
      },
    });

    logger.info(
      `[DUAL WRITE] Successfully propagated observations from partition ${partitionToProcess} to events table`,
    );

    // Track delay of the partition we just processed
    const processedPartitionTime = new Date(partitionToProcess).getTime();
    if (!isNaN(processedPartitionTime)) {
      const delaySeconds = (Date.now() - processedPartitionTime) / 1000;
      recordGauge(
        "langfuse.event_propagation.processed_partition_delay_seconds",
        delaySeconds,
      );
    }

    // Step 3: Update the last processed partition cursor in Redis
    // This allows the next job to continue from where we left off
    await updateLastProcessedPartition(partitionToProcess);
  } catch (error) {
    logger.error(
      "[DUAL WRITE] Failed to process event propagation batch",
      error,
    );
    traceException(error);
    throw error;
  }
};
