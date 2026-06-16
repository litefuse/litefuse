// Master events_full migration: this handler is FUNCTIONAL.
//
// Backfills experiment_* fields onto events_full rows when a user creates
// a dataset run in the UI relating to existing traces — langfuse-main
// pattern, ported to Doris + events_full.
//
// Trigger: eventPropagationProcessor runs runExperimentBackfill on a
// 5-minute cron behind a Redis lock. The procedure picks up
// dataset_run_items rows created since the last cursor, looks up the
// associated trace's spans in events_full, enriches them with the 12
// experiment_* fields from the DRI, and replays the enriched rows
// through IngestionService.writeEventRecord. Doris UNIQUE KEY MoW makes
// the replay idempotent — re-insert with the same span_id overwrites
// the prior row with the enriched version.
//
// SQL sources (post-OTel-only migration):
//   * getDatasetRunItemsSinceLastRun: dataset_run_items_rmt + LEFT ANTI
//     JOIN events_full (was `events` placeholder, now real).
//   * getRelevantTraces: events_full root spans (parent_span_id = '').
//   * getRelevantObservations: events_full non-root spans
//     (parent_span_id != '').
//
// Path-1 ingestion-time inline (SDK `experiment.run()`) is still
// authoritative — it sets experiment_* fields at write time via
// createEventRecord. This handler covers path-2 only: UI dataset runs
// relating to traces that were already ingested without experiment
// context.

import {
  logger,
  queryDoris,
  redis,
  convertDateToAnalyticsDateTime,
  flattenJsonToPathArrays,
  dorisClient,
  zipDorisMetadataArrays,
} from "@langfuse/shared/src/server";
import { env } from "../../env";
import { DorisWriter } from "../../services/DorisWriter";
import { IngestionService } from "../../services/IngestionService";
import { prisma } from "@langfuse/shared/src/db";
import { chunk } from "lodash";

const EXPERIMENT_BACKFILL_TIMESTAMP_KEY =
  "langfuse:event-propagation:experiment-backfill:last-run";
const EXPERIMENT_BACKFILL_LOCK_KEY = "langfuse:experiment-backfill:lock";
const LOCK_TTL_SECONDS = 300; // 5 minutes

export interface DatasetRunItem {
  id: string;
  project_id: string;
  trace_id: string;
  observation_id: string | null;
  dataset_run_id: string;
  dataset_run_name: string;
  dataset_run_description: string;
  dataset_run_metadata: Record<string, unknown>;
  dataset_id: string;
  dataset_item_version: string | null;
  dataset_item_id: string;
  dataset_item_expected_output: string;
  dataset_item_metadata: Record<string, unknown>;
  created_at: string;
}

export interface SpanRecord {
  project_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  start_time: string;
  end_time: string | null;
  name: string;
  type: string;
  environment: string;
  version: string;
  release: string;
  input: string;
  output: string;
  // Add other fields as needed from observations/traces
  level: string;
  status_message: string;
  completion_start_time: string | null;
  prompt_id: string;
  prompt_name: string;
  prompt_version: string | null;
  model_id: string;
  provided_model_name: string;
  model_parameters: string;
  provided_usage_details: Record<string, number> | null;
  usage_details: Record<string, number> | null;
  provided_cost_details: Record<string, number> | null;
  cost_details: Record<string, number> | null;
  total_cost: number;
  tool_definitions: Record<string, string>;
  tool_calls: string[];
  tool_call_names: string[];
  usage_pricing_tier_id: string | null;
  usage_pricing_tier_name: string | null;
  metadata: Record<string, unknown>;
  source: string;
  tags: Array<string>;
  bookmarked: boolean;
  public: boolean;
  trace_name: string;
  user_id: string;
  session_id: string;
}

export interface EnrichedSpan extends SpanRecord {
  experiment_id: string;
  experiment_name: string;
  experiment_metadata_names: string[];
  experiment_metadata_values: Array<string | null | undefined>;
  experiment_description: string;
  experiment_dataset_id: string;
  experiment_item_id: string;
  experiment_item_version: string | null;
  experiment_item_root_span_id: string;
  experiment_item_expected_output: string;
  experiment_item_metadata_names: string[];
  experiment_item_metadata_values: Array<string | null | undefined>;
}

export interface TraceProperties {
  name: string;
  userId: string;
  sessionId: string;
  version: string;
  release: string;
  tags: string[];
  bookmarked: boolean;
  public: boolean;
}

/**
 * Fetch dataset run items created within a time window.
 * Deduplicates by (project_id, trace_id, observation_id) taking the most recent.
 */
export async function getDatasetRunItemsSinceLastRun(
  lastRun: Date,
  upperBound: Date,
): Promise<DatasetRunItem[]> {
  const query = `
    WITH prefiltered_events as (
      -- Find trace_ids that ALREADY have experiment fields set in events_full
      -- (either via SDK experiment.run() ingestion or a prior backfill pass).
      -- LEFT ANTI JOIN below excludes these so backfill only enriches DRIs
      -- whose target trace is not yet experiment-tagged.
      select distinct project_id, trace_id
      from events_full
      where start_time > {lastRun: DateTime64(3)} - interval 1 day
        and experiment_id != ''
        and project_id in (
          select distinct project_id
          from dataset_run_items_rmt
          where created_at > {lastRun: DateTime64(3)}
        )
    )

    SELECT
      id,
      project_id,
      trace_id,
      observation_id,
      dataset_run_id,
      dataset_run_name,
      dataset_run_description,
      dataset_run_metadata,
      dataset_id,
      dataset_item_version,
      dataset_item_id,
      dataset_item_expected_output,
      dataset_item_metadata,
      created_at
    FROM (
      -- Doris has no LIMIT N BY clause; use ROW_NUMBER() OVER (...) WHERE rn=1
      -- to pick the latest DRI per (project_id, trace_id, observation_id).
      SELECT
        dri.id,
        dri.project_id,
        dri.trace_id,
        dri.observation_id,
        dri.dataset_run_id,
        dri.dataset_run_name,
        dri.dataset_run_description,
        dri.dataset_run_metadata,
        dri.dataset_id,
        dri.dataset_item_version,
        dri.dataset_item_id,
        dri.dataset_item_expected_output,
        dri.dataset_item_metadata,
        dri.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY dri.project_id, dri.trace_id, coalesce(dri.observation_id, '')
          ORDER BY dri.created_at DESC
        ) AS rn
      FROM dataset_run_items_rmt AS dri
      LEFT ANTI JOIN prefiltered_events AS pe
        ON dri.project_id = pe.project_id
        AND dri.trace_id = pe.trace_id
      WHERE dri.created_at > {lastRun: DateTime64(3)}
        AND dri.created_at <= {upperBound: DateTime64(3)}
    ) ranked
    WHERE rn = 1
    ORDER BY created_at DESC
  `;

  const rows = await queryDoris<DatasetRunItem>({
    query,
    params: {
      lastRun: convertDateToAnalyticsDateTime(lastRun),
      upperBound: convertDateToAnalyticsDateTime(upperBound),
    },
    tags: {
      feature: "experiment-backfill",
      operation_name: "getDatasetRunItemsSinceLastRun",
    },
  });

  logger.info(
    `[EXPERIMENT BACKFILL] Found ${rows.length} dataset run items between ${lastRun.toISOString()} and ${upperBound.toISOString()}`,
  );

  return rows;
}

/**
 * Fetch observations that belong to traces referenced by dataset run items.
 */
export async function getRelevantObservations(
  projectIds: string[],
  traceIds: string[],
  minTime: Date,
): Promise<SpanRecord[]> {
  if (projectIds.length === 0 || traceIds.length === 0) {
    return [];
  }

  // events_full layout: each observation span is a row with parent_span_id
  // != '' (root spans are the trace itself, handled by getRelevantTraces).
  // metadata is split across metadata_names / metadata_values arrays; we
  // zip them in TS after the read and synthesize the Map shape that
  // SpanRecord exposes. Dedup-per-span via ROW_NUMBER (Doris has no
  // LIMIT N BY).
  const query = `
    SELECT * FROM (
      SELECT
        o.project_id,
        o.trace_id,
        o.span_id AS span_id,
        o.parent_span_id AS parent_span_id,
        o.start_time,
        o.end_time,
        o.name,
        o.type,
        coalesce(o.environment, '') AS environment,
        coalesce(o.version, '') AS version,
        coalesce(o.\`release\`, '') AS \`release\`,
        coalesce(o.input, '') AS input,
        coalesce(o.output, '') AS output,
        o.level AS level,
        coalesce(o.status_message, '') AS status_message,
        o.completion_start_time AS completion_start_time,
        coalesce(o.prompt_id, '') AS prompt_id,
        coalesce(o.prompt_name, '') AS prompt_name,
        o.prompt_version AS prompt_version,
        coalesce(o.model_id, '') AS model_id,
        coalesce(o.provided_model_name, '') AS provided_model_name,
        coalesce(o.model_parameters, '{}') AS model_parameters,
        o.provided_usage_details AS provided_usage_details,
        o.usage_details AS usage_details,
        o.provided_cost_details AS provided_cost_details,
        o.cost_details AS cost_details,
        coalesce(o.total_cost, 0) AS total_cost,
        o.tool_definitions,
        o.tool_calls,
        o.tool_call_names,
        o.usage_pricing_tier_id,
        o.usage_pricing_tier_name,
        o.metadata_names AS metadata_names,
        o.metadata_values AS metadata_values,
        coalesce(o.source, 'experiment-backfill') AS source,
        o.tags AS tags,
        o.bookmarked AS bookmarked,
        o.\`public\` AS \`public\`,
        coalesce(o.trace_name, '') AS trace_name,
        coalesce(o.user_id, '') AS user_id,
        coalesce(o.session_id, '') AS session_id,
        ROW_NUMBER() OVER (
          PARTITION BY o.project_id, o.span_id
          ORDER BY o.event_ts DESC
        ) AS rn
      FROM events_full o
      WHERE o.project_id IN ({projectIds: Array(String)})
        AND o.trace_id IN ({traceIds: Array(String)})
        AND o.parent_span_id != ''
        AND o.start_time >= {minTime: DateTime64(3)} - interval 4 hour
    ) ranked
    WHERE rn = 1
  `;

  type RawObsRow = Omit<SpanRecord, "metadata"> & {
    metadata_names: unknown;
    metadata_values: unknown;
  };
  const rows = await queryDoris<RawObsRow>({
    query,
    params: {
      projectIds,
      traceIds,
      minTime: convertDateToAnalyticsDateTime(minTime),
    },
    tags: {
      feature: "experiment-backfill",
      operation_name: "getRelevantObservations",
    },
  });
  return rows.map((row) => {
    const { metadata_names, metadata_values, ...rest } = row;
    return {
      ...rest,
      metadata: zipDorisMetadataArrays(metadata_names, metadata_values),
    };
  });
}

/**
 * Fetch traces that are referenced by dataset run items.
 */
export async function getRelevantTraces(
  projectIds: string[],
  traceIds: string[],
  minTime: Date,
): Promise<SpanRecord[]> {
  if (projectIds.length === 0 || traceIds.length === 0) {
    return [];
  }

  // Trace identity comes from events_full's OTel root span
  // (parent_span_id = ''). Latest event_ts wins within the project / trace
  // pair, mirroring buildTraceAggregationQuery's "trace_root" CTE choice.
  // events_full carries trace-level fields denormalised on the root span,
  // so we don't need a separate CTE for them — read them straight off o.
  const query = `
    SELECT * FROM (
      SELECT
        o.project_id,
        o.trace_id,
        o.span_id AS span_id,
        o.parent_span_id AS parent_span_id,
        o.start_time AS start_time,
        o.end_time AS end_time,
        coalesce(o.trace_name, o.name) AS name,
        'SPAN' AS type,
        coalesce(o.environment, '') AS environment,
        coalesce(o.version, '') AS version,
        coalesce(o.\`release\`, '') AS \`release\`,
        coalesce(o.input, '') AS input,
        coalesce(o.output, '') AS output,
        coalesce(o.level, '') AS level,
        coalesce(o.status_message, '') AS status_message,
        o.completion_start_time AS completion_start_time,
        '' AS prompt_id,
        '' AS prompt_name,
        '' AS prompt_version,
        '' AS model_id,
        '' AS provided_model_name,
        '' AS model_parameters,
        map() AS provided_usage_details,
        map() AS usage_details,
        map() AS provided_cost_details,
        map() AS cost_details,
        0 AS total_cost,
        map() AS tool_definitions,
        [] AS tool_calls,
        [] AS tool_call_names,
        o.metadata_names AS metadata_names,
        o.metadata_values AS metadata_values,
        coalesce(o.source, 'experiment-backfill') AS source,
        o.tags AS tags,
        o.bookmarked AS bookmarked,
        o.\`public\` AS \`public\`,
        coalesce(o.trace_name, o.name) AS trace_name,
        coalesce(o.user_id, '') AS user_id,
        coalesce(o.session_id, '') AS session_id,
        ROW_NUMBER() OVER (
          PARTITION BY o.project_id, o.trace_id
          ORDER BY o.event_ts DESC
        ) AS rn
      FROM events_full o
      WHERE o.project_id IN ({projectIds: Array(String)})
        AND o.trace_id IN ({traceIds: Array(String)})
        AND o.parent_span_id = ''
        AND o.start_time >= {minTime: DateTime64(3)} - interval 4 hour
    ) ranked
    WHERE rn = 1
  `;

  type RawTraceRow = Omit<SpanRecord, "metadata"> & {
    metadata_names: unknown;
    metadata_values: unknown;
  };
  const rows = await queryDoris<RawTraceRow>({
    query,
    params: {
      projectIds,
      traceIds,
      minTime: convertDateToAnalyticsDateTime(minTime),
    },
    tags: {
      feature: "experiment-backfill",
      operation_name: "getRelevantTraces",
    },
  });
  return rows.map((row) => {
    const { metadata_names, metadata_values, ...rest } = row;
    return {
      ...rest,
      metadata: zipDorisMetadataArrays(metadata_names, metadata_values),
    };
  });
}

/**
 * Build span and child maps for efficient lookups and tree traversal.
 */
export function buildSpanMaps(spans: SpanRecord[]): {
  spanMap: Map<string, SpanRecord>;
  childMap: Map<string, SpanRecord[]>;
} {
  const spanMap = new Map<string, SpanRecord>();
  const childMap = new Map<string, SpanRecord[]>();

  for (const span of spans) {
    spanMap.set(span.span_id, span);

    // Add to parent's children list
    const parentId = span.parent_span_id;
    if (!childMap.has(parentId)) {
      childMap.set(parentId, []);
    }
    childMap.get(parentId)!.push(span);
  }

  return { spanMap, childMap };
}

/**
 * Recursively find all child spans for a given root span.
 */
export function findAllChildren(
  rootSpanId: string,
  childMap: Map<string, SpanRecord[]>,
): SpanRecord[] {
  const children: SpanRecord[] = [];
  const queue: string[] = [rootSpanId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const directChildren = childMap.get(currentId) || [];

    for (const child of directChildren) {
      children.push(child);
      queue.push(child.span_id);
    }
  }

  return children;
}

/**
 * Convert a SpanRecord to EnrichedSpan format with empty experiment fields.
 * Used for spans that are not part of any dataset run item but should still be included in events.
 */
function convertToEnrichedSpanWithoutExperiment(
  span: SpanRecord,
  traceProperties: TraceProperties | undefined,
): EnrichedSpan {
  return {
    ...span,
    trace_name: traceProperties?.name || "",
    user_id: traceProperties?.userId || "",
    session_id: traceProperties?.sessionId || "",
    version: span.version || traceProperties?.version || "",
    release: traceProperties?.release || "",
    tags: traceProperties?.tags || [],
    bookmarked: traceProperties?.bookmarked || false,
    public: traceProperties?.public || false,
    experiment_id: "",
    experiment_name: "",
    experiment_metadata_names: [],
    experiment_metadata_values: [],
    experiment_description: "",
    experiment_dataset_id: "",
    experiment_item_id: "",
    experiment_item_version: null,
    experiment_item_root_span_id: "",
    experiment_item_expected_output: "",
    experiment_item_metadata_names: [],
    experiment_item_metadata_values: [],
  };
}

/**
 * Enrich spans with experiment properties from dataset run item.
 * Also propagates trace-level properties (userId, sessionId) to all child spans.
 */
export function enrichSpansWithExperiment(
  rootSpan: SpanRecord,
  childSpans: SpanRecord[],
  dri: DatasetRunItem,
  traceProperties: TraceProperties | undefined,
): EnrichedSpan[] {
  const enrichedSpans: EnrichedSpan[] = [];

  const experimentMetadataFlattened = flattenJsonToPathArrays(
    dri.dataset_run_metadata,
  );
  const experimentItemMetadataFlattened = flattenJsonToPathArrays(
    dri.dataset_item_metadata,
  );

  // Enrich root span
  enrichedSpans.push({
    ...rootSpan,
    trace_name: traceProperties?.name || "",
    user_id: traceProperties?.userId || "",
    session_id: traceProperties?.sessionId || "",
    version: rootSpan.version || traceProperties?.version || "",
    release: traceProperties?.release || "",
    tags: traceProperties?.tags || [],
    bookmarked: traceProperties?.bookmarked || false,
    public: traceProperties?.public || false,
    experiment_id: dri.dataset_run_id,
    experiment_name: dri.dataset_run_name,
    experiment_metadata_names: experimentMetadataFlattened.names,
    experiment_metadata_values: experimentMetadataFlattened.values,
    experiment_description: dri.dataset_run_description,
    experiment_dataset_id: dri.dataset_id,
    experiment_item_id: dri.dataset_item_id,
    experiment_item_version: dri.dataset_item_version,
    experiment_item_root_span_id: rootSpan.span_id,
    experiment_item_expected_output: dri.dataset_item_expected_output,
    experiment_item_metadata_names: experimentItemMetadataFlattened.names,
    experiment_item_metadata_values: experimentItemMetadataFlattened.values,
  });

  // Enrich child spans
  for (const child of childSpans) {
    enrichedSpans.push({
      ...child,
      trace_name: traceProperties?.name || "",
      user_id: traceProperties?.userId || "",
      session_id: traceProperties?.sessionId || "",
      version: child.version || traceProperties?.version || "",
      release: traceProperties?.release || "",
      tags: traceProperties?.tags || [],
      public: traceProperties?.public || false,
      experiment_id: dri.dataset_run_id,
      experiment_name: dri.dataset_run_name,
      experiment_metadata_names: experimentMetadataFlattened.names,
      experiment_metadata_values: experimentMetadataFlattened.values,
      experiment_description: dri.dataset_run_description,
      experiment_dataset_id: dri.dataset_id,
      experiment_item_id: dri.dataset_item_id,
      experiment_item_version: dri.dataset_item_version,
      experiment_item_root_span_id: rootSpan.span_id,
      experiment_item_expected_output: dri.dataset_item_expected_output,
      experiment_item_metadata_names: experimentItemMetadataFlattened.names,
      experiment_item_metadata_values: experimentItemMetadataFlattened.values,
    });
  }

  return enrichedSpans;
}

/**
 * Write enriched spans to the events table using IngestionService.writeEventRecord().
 * Converts EnrichedSpan to EventInput format.
 */
export async function writeEnrichedSpans(spans: EnrichedSpan[]): Promise<void> {
  if (spans.length === 0) {
    return;
  }

  // Ensure required dependencies are available
  if (!redis) throw new Error("Redis not available");
  if (!prisma) throw new Error("Prisma not available");

  const ingestionService = new IngestionService(
    redis,
    prisma,
    DorisWriter.getInstance(),
    dorisClient(),
  );

  for (const span of spans) {
    // Convert EnrichedSpan to EventInput format
    const eventInput = {
      // Required identifiers
      projectId: span.project_id,
      traceId: span.trace_id,
      spanId: span.span_id,
      startTimeISO: span.start_time,
      endTimeISO: span.end_time || span.start_time, // Required field, use start_time as fallback

      // Optional identifiers
      parentSpanId: span.parent_span_id || undefined,

      // Core properties
      name: span.name,
      type: span.type,
      environment: span.environment || undefined,
      version: span.version || undefined,
      release: span.release || undefined,
      tags: span.tags || [],
      bookmarked: span.bookmarked || false,
      public: span.public || false,
      completionStartTime: span.completion_start_time || undefined,

      // User/session
      traceName: span.trace_name || undefined,
      userId: span.user_id || undefined,
      sessionId: span.session_id || undefined,
      level: span.level || undefined,
      statusMessage: span.status_message || undefined,

      // Prompt
      promptId: span.prompt_id || undefined,
      promptName: span.prompt_name || undefined,
      promptVersion: span.prompt_version || undefined,

      // Model
      modelName: span.provided_model_name || undefined,
      modelParameters: span.model_parameters || undefined,

      // Usage & Cost
      providedUsageDetails: span.provided_usage_details || undefined,
      usageDetails: span.usage_details || undefined,
      providedCostDetails: span.provided_cost_details || undefined,
      costDetails: span.cost_details || undefined,
      totalCost: span.total_cost || undefined,

      // Tool calls
      toolDefinitions: span.tool_definitions || {},
      toolCalls: span.tool_calls || [],
      toolCallNames: span.tool_call_names || [],

      usagePricingTierId: span.usage_pricing_tier_id || undefined,
      usagePricingTierName: span.usage_pricing_tier_name || undefined,

      // I/O
      input: span.input || undefined,
      output: span.output || undefined,

      // Metadata
      metadata: span.metadata,

      // Source/instrumentation
      source: span.source,

      // Experiment fields
      experimentId: span.experiment_id,
      experimentName: span.experiment_name,
      experimentMetadataNames: span.experiment_metadata_names,
      experimentMetadataValues: span.experiment_metadata_values,
      experimentDescription: span.experiment_description,
      experimentDatasetId: span.experiment_dataset_id,
      experimentItemId: span.experiment_item_id,
      experimentItemVersion: span.experiment_item_version || undefined,
      experimentItemRootSpanId: span.experiment_item_root_span_id,
      experimentItemExpectedOutput: span.experiment_item_expected_output,
      experimentItemMetadataNames: span.experiment_item_metadata_names,
      experimentItemMetadataValues: span.experiment_item_metadata_values,
    };

    const eventRecord = await ingestionService.createEventRecord(
      eventInput,
      "",
    ); // Empty fileKey since we're not storing raw events
    ingestionService.writeEventRecord(eventRecord);
  }

  logger.info(
    `[EXPERIMENT BACKFILL] Wrote ${spans.length} enriched spans to events table via IngestionService`,
  );
}

/**
 * Initialize the experiment backfill cutoff timestamp if not already set.
 * Uses Redis SET NX to ensure we don't backfill historical data on first run.
 *
 * @returns The cutoff timestamp to use for backfill queries
 */
export async function initializeBackfillCutoff(): Promise<Date> {
  if (!redis) {
    logger.error(
      "[EXPERIMENT BACKFILL] Redis not available, using current time as cutoff",
    );
    throw new Error(
      "Redis not available. Experiment backfill cannot be initialized.",
    );
  }

  try {
    const now = new Date().toISOString();

    // Try to set the key only if it doesn't exist (NX)
    const result = await redis.set(
      EXPERIMENT_BACKFILL_TIMESTAMP_KEY,
      now,
      "NX",
    );

    if (result === "OK") {
      logger.info(
        `[EXPERIMENT BACKFILL] Initialized cutoff timestamp to ${now} (first run)`,
      );
      return new Date(now);
    }

    // Key already exists, fetch the existing value
    const existing = await redis.get(EXPERIMENT_BACKFILL_TIMESTAMP_KEY);
    if (existing) {
      logger.debug(
        `[EXPERIMENT BACKFILL] Using existing cutoff timestamp: ${existing}`,
      );
      return new Date(existing);
    }

    // Fallback if something went wrong
    logger.warn(
      "[EXPERIMENT BACKFILL] Could not read existing timestamp, using current time",
    );
    return new Date();
  } catch (error) {
    logger.error(
      "[EXPERIMENT BACKFILL] Failed to initialize cutoff timestamp",
      error,
    );
    return new Date();
  }
}

/**
 * Check if the experiment backfill should run based on the throttle and lock acquisition.
 * (Default every 5min).
 *
 * First checks if enough time has passed since the last run.
 * Then attempts to acquire a distributed lock to ensure only one worker runs the backfill.
 *
 * @returns true if backfill should run (time threshold passed AND lock acquired), false otherwise
 */
export async function shouldRunBackfill(lastRun: Date): Promise<boolean> {
  // First check time-based throttle
  const now = new Date();
  const timeSinceLastRun = now.getTime() - lastRun.getTime();

  if (timeSinceLastRun < env.LITEFUSE_EXPERIMENT_BACKFILL_THROTTLE_MS) {
    logger.debug(
      "[EXPERIMENT BACKFILL] Skipping due to throttle (time threshold not met)",
    );
    return false;
  }

  // Time threshold passed, now try to acquire lock
  if (!redis) {
    logger.warn(
      "[EXPERIMENT BACKFILL] Redis not available, skipping lock acquisition",
    );
    return true; // Allow processing if Redis is unavailable
  }

  try {
    // Try to acquire lock using Redis SET NX (atomic test-and-set)
    const result = await redis.set(
      EXPERIMENT_BACKFILL_LOCK_KEY,
      "true",
      "EX",
      LOCK_TTL_SECONDS,
      "NX",
    );

    const acquired = result === "OK";

    if (acquired) {
      logger.info(
        `[EXPERIMENT BACKFILL] Acquired backfill lock with TTL ${LOCK_TTL_SECONDS}s`,
      );
    } else {
      logger.debug(
        "[EXPERIMENT BACKFILL] Backfill is already locked by another worker",
      );
    }

    return acquired;
  } catch (error) {
    logger.error(
      "[EXPERIMENT BACKFILL] Failed to acquire backfill lock",
      error,
    );
    // On error, allow processing to avoid blocking the system
    return true;
  }
}

/**
 * Update the experiment backfill timestamp after successful execution.
 * @param timestamp The timestamp to set (should be the upper bound used for the backfill)
 */
export async function updateBackfillTimestamp(timestamp: Date): Promise<void> {
  if (!redis) {
    logger.warn(
      "[EXPERIMENT BACKFILL] Redis not available, cannot update timestamp",
    );
    return;
  }

  try {
    const timestampStr = timestamp.toISOString();
    await redis.set(EXPERIMENT_BACKFILL_TIMESTAMP_KEY, timestampStr);
    logger.info(
      `[EXPERIMENT BACKFILL] Updated last run timestamp to ${timestampStr}`,
    );
  } catch (error) {
    logger.error("[EXPERIMENT BACKFILL] Failed to update timestamp", error);
  }
}

/**
 * Main entry point for experiment backfill.
 * Handles initialization, throttle checking, execution, and timestamp updates.
 */
export async function runExperimentBackfill(): Promise<void> {
  logger.info("[EXPERIMENT BACKFILL] Checking if backfill should run");

  try {
    // Initialize cutoff timestamp (first-run protection)
    const lastRun = await initializeBackfillCutoff();

    // Check 5-minute throttle
    if (!(await shouldRunBackfill(lastRun))) {
      logger.debug("[EXPERIMENT BACKFILL] Skipping due to throttle");
      return;
    }

    // Calculate upper bound (now - 30s) to avoid race conditions
    // This ensures we don't process items that might still be receiving data
    const upperBound = new Date(Date.now() - 30 * 1000);

    // Execute backfill
    logger.info("[EXPERIMENT BACKFILL] Starting backfill process");
    await processExperimentBackfill(lastRun, upperBound);

    // Update timestamp with the upper bound we processed up to
    await updateBackfillTimestamp(upperBound);
    logger.info("[EXPERIMENT BACKFILL] Backfill completed successfully");
  } catch (error) {
    logger.error("[EXPERIMENT BACKFILL] Failed to run backfill", error);
    throw error;
  }
}

/**
 * Internal orchestration function to process experiment backfill.
 */
async function processExperimentBackfill(
  lastRun: Date,
  upperBound: Date,
): Promise<void> {
  logger.info(
    `[EXPERIMENT BACKFILL] Starting backfill process with lastRun ${lastRun.toISOString()} and upperBound ${upperBound.toISOString()}`,
  );

  // Step 1: Fetch dataset run items within time window [lastRun, upperBound]
  const allDatasetRunItems = await getDatasetRunItemsSinceLastRun(
    lastRun,
    upperBound,
  );

  if (allDatasetRunItems.length === 0) {
    logger.info(
      "[EXPERIMENT BACKFILL] No dataset run items to process, skipping",
    );
    return;
  }

  // Step 2: Process in chunks
  const chunkSize = env.LITEFUSE_DATASET_RUN_BACKFILL_CHUNK_SIZE;
  const chunks = chunk(allDatasetRunItems, chunkSize);

  logger.info(
    `[EXPERIMENT BACKFILL] Processing ${allDatasetRunItems.length} items in ${chunks.length} chunks of ${chunkSize}`,
  );

  for (let i = 0; i < chunks.length; i++) {
    const driChunk = chunks[i];
    logger.info(
      `[EXPERIMENT BACKFILL] Processing chunk ${i + 1}/${chunks.length} with ${driChunk.length} items`,
    );

    // Extract project and trace IDs for this chunk
    const projectIds = [...new Set(driChunk.map((dri) => dri.project_id))];
    const traceIds = [...new Set(driChunk.map((dri) => dri.trace_id))];

    // Fetch observations and traces
    const [observations, traces] = await Promise.all([
      getRelevantObservations(projectIds, traceIds, lastRun),
      getRelevantTraces(projectIds, traceIds, lastRun),
    ]);

    logger.info(
      `[EXPERIMENT BACKFILL] Fetched ${observations.length} observations and ${traces.length} traces`,
    );

    // Combine spans
    const allSpans = [...observations, ...traces];
    const { spanMap, childMap } = buildSpanMaps(allSpans);

    // Build a map of trace_id -> {userId, sessionId} for efficient lookup
    const tracePropertiesMap = new Map<string, TraceProperties>();
    // OTel-only events_full: the trace's "root span" is the actual OTel root
    // span (parent_span_id = ''), not a synthetic `t-<trace_id>` row. Build
    // a trace_id -> rootSpanId lookup so DRIs that point at the trace (no
    // observation_id) can find the real root span by its actual span_id.
    const traceRootSpanIdMap = new Map<string, string>();
    for (const trace of traces) {
      tracePropertiesMap.set(trace.trace_id, {
        name: trace.name,
        userId: trace.user_id,
        sessionId: trace.session_id,
        version: trace.version,
        release: trace.release,
        tags: trace.tags,
        bookmarked: trace.bookmarked,
        public: trace.public,
      });
      traceRootSpanIdMap.set(trace.trace_id, trace.span_id);
    }

    // Process each dataset run item
    const allEnrichedSpans: EnrichedSpan[] = [];
    const processedSpanIds = new Set<string>();

    for (const dri of driChunk) {
      // Find the root span (either the observation the DRI explicitly points
      // at, or — for trace-level DRIs — the OTel root span of dri.trace_id).
      const rootSpanId =
        dri.observation_id ?? traceRootSpanIdMap.get(dri.trace_id) ?? "";
      const rootSpan = rootSpanId ? spanMap.get(rootSpanId) : undefined;

      if (!rootSpan) {
        logger.warn(
          `[EXPERIMENT BACKFILL] Root span ${rootSpanId || "(unknown)"} not found for DRI ${dri.id} (trace ${dri.trace_id}), skipping`,
        );
        continue;
      }

      // Get trace-level properties for this trace
      const traceProperties = tracePropertiesMap.get(dri.trace_id);

      // Find all children recursively
      const childSpans = findAllChildren(rootSpanId, childMap);

      // Enrich spans with experiment properties and propagate trace-level properties
      const enrichedSpans = enrichSpansWithExperiment(
        rootSpan,
        childSpans,
        dri,
        traceProperties,
      );

      allEnrichedSpans.push(...enrichedSpans);

      // Track which spans have been processed
      processedSpanIds.add(rootSpan.span_id);
      for (const child of childSpans) {
        processedSpanIds.add(child.span_id);
      }
    }

    // Add all remaining spans that weren't enriched (e.g., trace-derived spans that weren't roots)
    for (const span of allSpans) {
      if (!processedSpanIds.has(span.span_id)) {
        const traceProperties = tracePropertiesMap.get(span.trace_id);
        allEnrichedSpans.push(
          convertToEnrichedSpanWithoutExperiment(span, traceProperties),
        );
      }
    }

    // Write enriched spans to events table
    if (allEnrichedSpans.length > 0) {
      await writeEnrichedSpans(allEnrichedSpans);
    }
  }

  logger.info(
    `[EXPERIMENT BACKFILL] Completed backfill process for ${allDatasetRunItems.length} items`,
  );
}
