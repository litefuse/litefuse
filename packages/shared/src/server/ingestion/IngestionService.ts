import { v4 } from "uuid";
import { Decimal } from "decimal.js";
import { env } from "../../env";
import {
  Model,
  ObservationLevel,
  PrismaClient,
  Prompt,
} from "@langfuse/shared";
import {
  convertScoreReadToInsert,
  DorisClientType,
  eventTypes,
  IngestionEntityTypes,
  IngestionEventType,
  instrumentAsync,
  logger,
  ObservationEvent,
  observationRecordInsertSchema,
  ObservationRecordInsertType,
  PromptService,
  QueueJobs,
  recordIncrement,
  ScoreEventType,
  DatasetRunItemEventType,
  scoreRecordInsertSchema,
  ScoreRecordInsertType,
  scoreRecordReadSchema,
  TraceEventType,
  traceRecordInsertSchema,
  TraceRecordInsertType,
  UsageCostType,
  QueueName,
  enqueuePgBossJob,
  findModel,
  matchPricingTier,
  validateAndInflateScore,
  DatasetRunItemRecordInsertType,
  EventRecordInsertType,
  traceException,
  flattenJsonToPathArrays,
  getDatasetItemById,
  extractToolsFromObservation,
  convertDefinitionsToMap,
  convertCallsToArrays,
  hasNoEvalConfigsCache,
  convertDateToAnalyticsDateTime,
} from "@langfuse/shared/src/server";

import { IIngestionWriter, TableName } from "./ingestionWriter";
import {
  convertJsonSchemaToRecord,
  convertPostgresJsonToMetadataRecord,
  convertRecordValuesToString,
  overwriteObject,
} from "./ingestionServiceUtils";

/**
 * Optional token-count callbacks. Worker passes implementations backed by
 * worker_threads; web can pass a synchronous fallback (or omit if it does
 * not need to recompute usage for events that already carry token counts).
 *
 * When the corresponding callback is not provided, IngestionService skips
 * recompute and falls back to whatever the SDK supplied verbatim.
 */
export type TokenCountFn = (params: {
  model: Model;
  text: unknown;
}) => number | undefined;

export type TokenCountAsyncFn = (params: {
  model: Model;
  text: unknown;
}) => Promise<number | undefined>;

type InsertRecord =
  | TraceRecordInsertType
  | ScoreRecordInsertType
  | ObservationRecordInsertType
  | DatasetRunItemRecordInsertType;

/**
 * Flexible input type for writing events to the events table.
 * This is intentionally loose to allow for iteration as the events
 * table schema evolves. Only required fields are enforced.
 */
export type EventInput = {
  // Required identifiers
  projectId: string;
  traceId: string;
  spanId: string;
  startTimeISO: string;

  // Optional identifiers
  orgId?: string;
  parentSpanId?: string;

  // Core properties
  name?: string;
  type?: string;
  environment?: string;
  version?: string;
  release?: string;
  endTimeISO: string;
  completionStartTime?: string;

  traceName?: string;
  tags?: string[];
  bookmarked?: boolean;
  public?: boolean;

  // User/session
  userId?: string;
  sessionId?: string;
  level?: string;
  statusMessage?: string;

  // Prompt
  promptId?: string;
  promptName?: string;
  promptVersion?: string;

  // Model
  modelId?: string;
  modelName?: string;
  modelParameters?: string | Record<string, unknown>;

  // Usage & Cost
  providedUsageDetails?: Record<string, number>;
  usageDetails?: Record<string, number>;
  providedCostDetails?: Record<string, number>;
  costDetails?: Record<string, number>;

  // Tool Calls
  toolDefinitions?: Record<string, string>;
  toolCalls?: string[];
  toolCallNames?: string[];

  // I/O
  input?: string;
  output?: string;

  // Metadata
  // metadata can be a complex nested object with attributes, resourceAttributes, scopeAttributes, etc.
  metadata: Record<string, unknown>;

  // Source/instrumentation metadata
  source: string;
  serviceName?: string;
  serviceVersion?: string;
  scopeName?: string;
  scopeVersion?: string;
  telemetrySdkLanguage?: string;
  telemetrySdkName?: string;
  telemetrySdkVersion?: string;

  // Storage
  blobStorageFilePath?: string;
  eventRaw?: string;
  eventBytes?: number;

  // Experiment fields
  experimentId?: string;
  experimentName?: string;
  experimentMetadataNames?: string[];
  experimentMetadataValues?: Array<string | null | undefined>;
  experimentDescription?: string;
  experimentDatasetId?: string;
  experimentItemId?: string;
  experimentItemVersion?: string;
  experimentItemRootSpanId?: string;
  experimentItemExpectedOutput?: string;
  experimentItemMetadataNames?: string[];
  experimentItemMetadataValues?: Array<string | null | undefined>;

  // Catch-all for future fields
  [key: string]: any;
};

type DirectTraceContext = {
  traceId: string;
  timestamp?: string | null;
  name?: string | null;
  input?: unknown;
  output?: unknown;
  sessionId?: string | null;
  userId?: string | null;
  environment?: string | null;
  metadata?: Record<string, unknown> | null;
  release?: string | null;
  version?: string | null;
  public?: boolean | null;
  tags?: string[];
};

const immutableEntityKeys: {
  [TableName.Traces]: (keyof TraceRecordInsertType)[];
  [TableName.Scores]: (keyof ScoreRecordInsertType)[];
  [TableName.Observations]: (keyof ObservationRecordInsertType)[];
} = {
  [TableName.Traces]: [
    "id",
    "project_id",
    "timestamp",
    "created_at",
    "environment",
  ],
  [TableName.Scores]: [
    "id",
    "project_id",
    "timestamp",
    "trace_id",
    "created_at",
    "environment",
  ],
  [TableName.Observations]: [
    "id",
    "project_id",
    "trace_id",
    "start_time",
    "created_at",
    "environment",
  ],
};

// ---------------------------------------------------------------------------
// events_full helpers
// ---------------------------------------------------------------------------

/**
 * Dedupe + lexicographic sort of a flattened metadata pair. Same output
 * order as the previous (now-removed) cross-batch merge helper —
 * deterministic ordering keeps Stream Load payloads stable for log
 * diffing and replay.
 */
function sortFlatMetadata(
  names: string[],
  values: Array<string | null | undefined>,
): { names: string[]; values: Array<string | null | undefined> } {
  const deduped = new Map<string, string | null | undefined>();
  for (let i = 0; i < names.length; i++) {
    deduped.set(names[i], values[i]);
  }
  const sortedNames = Array.from(deduped.keys()).sort();
  const sortedValues = sortedNames.map((k) => deduped.get(k));
  return { names: sortedNames, values: sortedValues };
}

export class IngestionService {
  private promptService: PromptService;

  /**
   * @param prisma - Prisma client (PG metadata lookups, trace_sessions upsert).
   * @param ingestionWriter - Writer that accepts records keyed by Doris
   *   physical table. Worker passes the singleton DorisWriter; web later
   *   passes a per-request RequestWriteBuffer. `null` is allowed for code
   *   paths that build records but never persist (e.g. tests).
   * @param dorisClient - Doris client for pre-read merge context lookups.
   * @param tokenCountAsync - Optional async token counter (worker_threads
   *   backed in worker). If omitted, async token recomputes are skipped.
   * @param tokenCount - Optional sync token counter. If omitted, sync
   *   token recomputes are skipped.
   */
  constructor(
    private prisma: PrismaClient,
    private dorisWriter: IIngestionWriter | null,
    private dorisClient: DorisClientType | null,
    private tokenCountAsync: TokenCountAsyncFn | null = null,
    private tokenCount: TokenCountFn | null = null,
  ) {
    this.promptService = new PromptService(prisma);
  }

  public async mergeAndWrite(
    eventType: IngestionEntityTypes,
    projectId: string,
    eventBodyId: string,
    createdAtTimestamp: Date,
    events: IngestionEventType[],
  ): Promise<void> {
    logger.debug(
      `Merging ingestion ${eventType} event for project ${projectId} and event ${eventBodyId}`,
    );

    // OTel-only Lightweight no longer serializes same-entity writes.
    // The route rejects pre-v4 Python / pre-v5 JS SDKs, so every
    // batch reaching this point comes from a pure-OTel exporter where
    // a single span = a single HTTP request with all attributes
    // inlined. SDK retries replay the same protobuf payload, so the
    // Doris UNIQUE KEY (project_id, span_id) MoW resolution by load
    // order keeps duplicates idempotent. The pg_advisory_xact_lock +
    // flushNow path that used to live here was defense against the
    // v3 create/update split race and is no longer load-bearing.
    // Records are buffered in the writer and drained by the request
    // handler's trailing flushAll().
    switch (eventType) {
      case "trace":
        await this.processTraceEventList({
          projectId,
          entityId: eventBodyId,
          createdAtTimestamp,
          traceEventList: events as TraceEventType[],
        });
        break;
      case "observation":
        await this.processObservationEventList({
          projectId,
          entityId: eventBodyId,
          createdAtTimestamp,
          observationEventList: events as ObservationEvent[],
        });
        break;
      case "score":
        await this.processScoreEventList({
          projectId,
          entityId: eventBodyId,
          createdAtTimestamp,
          scoreEventList: events as ScoreEventType[],
        });
        break;
      case "dataset_run_item":
        await this.processDatasetRunItemEventList({
          projectId,
          entityId: eventBodyId,
          createdAtTimestamp,
          datasetRunItemEventList: events as DatasetRunItemEventType[],
        });
        break;
    }
  }

  /**
   * Creates an EventRecordInsertType from EventInput.
   * Performs all necessary enrichments:
   * - Prompt lookup (by name + version)
   * - Model/usage enrichment (tokenization, cost calculation)
   * - Metadata flattening
   * - Timestamp normalization
   *
   * This is the single point of transformation from loose EventInput
   * to strict EventRecordInsertType.
   *
   * @param eventData - The event data from processToEvent()
   * @param fileKey - The file key where the raw event data is stored
   * @returns The enriched event record ready for writing or eval scheduling
   */
  public async createEventRecord(
    eventData: EventInput,
    fileKey: string,
  ): Promise<EventRecordInsertType> {
    logger.debug(
      `Creating event record for project ${eventData.projectId} and span ${eventData.spanId}`,
    );

    // Perform lookups for prompt and model/usage enrichment
    const [prompt, generationUsage] = await Promise.all([
      // Lookup prompt by name and version
      eventData.promptName && eventData.promptVersion
        ? this.promptService.getPrompt({
            projectId: eventData.projectId,
            promptName: eventData.promptName,
            version:
              typeof eventData.promptVersion === "string"
                ? parseInt(eventData.promptVersion, 10)
                : eventData.promptVersion,
            label: undefined,
          })
        : null,
      // Lookup model and enrich usage/cost details (includes tokenization if needed)
      eventData.modelName
        ? this.getGenerationUsage({
            projectId: eventData.projectId,
            observationRecord: {
              id: eventData.spanId,
              project_id: eventData.projectId,
              trace_id: eventData.traceId,
              provided_model_name: eventData.modelName,
              provided_usage_details: eventData.providedUsageDetails ?? {},
              provided_cost_details: eventData.providedCostDetails ?? {},
              input: eventData.input,
              output: eventData.output,
            },
          })
        : null,
    ]);

    // Doris events_full uses DateTime(3) (millisecond precision). Upstream
    // main writes to ClickHouse and historically used microseconds here;
    // sending microseconds to Doris produces year ~58335 timestamps that
    // then fail start_time_date derivation. Keep this path in ms so it
    // matches the mergeAndWrite path (mapTraceEventsToRecords /
    // mapObservationEventsToRecords both use getMillisecondTimestamp).
    const now = this.getMillisecondTimestamp();

    // Flatten raw metadata into parallel arrays (metadata_names / metadata_values).
    // Cross-batch deep-merge with prior row state is handled by the dual-write
    // path's targeted 3-column pre-read, not here. The OTel direct-write path
    // skips that pre-read entirely (each OTel span carries complete metadata).
    const flattened = eventData.metadata
      ? flattenJsonToPathArrays(eventData.metadata)
      : { names: [], values: [] };
    const metadataNames = flattened.names;
    // Defensive: coerce null/undefined to empty string for ARRAY<String> Doris column.
    const metadataValues = flattened.values.map((v) => v ?? "");

    const eventRecord: EventRecordInsertType = {
      // Required identifiers
      id: eventData.spanId,
      project_id: eventData.projectId,
      trace_id: eventData.traceId,
      span_id: eventData.spanId,

      // Root OTel spans arrive with parentSpanId=null. Upstream
      // ClickHouse stores root-span markers as the empty string `''`
      // (CH `String` is non-nullable, coerces null on insert); upstream
      // queries use `parent_span_id = ''` to find root spans. Doris
      // `String` is nullable, so the same null input would stay NULL
      // and miss those equality checks. Coerce to '' here so Litefuse
      // matches upstream's wire-level invariant.
      parent_span_id: eventData.parentSpanId ?? "",

      // Core properties with defaults
      name: eventData.name ?? "",
      type: eventData.type ?? "SPAN",
      environment: eventData.environment ?? "default",
      version: eventData.version,
      release: eventData.release,

      tags: eventData.tags ?? [],
      bookmarked: eventData.bookmarked ?? false,
      public: eventData.public ?? false,

      // Trace-level attributes: Name/User/session
      trace_name: eventData.traceName,
      user_id: eventData.userId,
      session_id: eventData.sessionId,

      // Status
      level: eventData.level ?? "DEFAULT",
      status_message: eventData.statusMessage,

      // Timestamps (millisecond precision — see comment on `now` above).
      start_time: this.getMillisecondTimestamp(eventData.startTimeISO),
      end_time: this.getMillisecondTimestamp(eventData.endTimeISO),
      completion_start_time: eventData.completionStartTime
        ? this.getMillisecondTimestamp(eventData.completionStartTime)
        : null,

      // Prompt
      prompt_id: prompt?.id || "",
      prompt_name: eventData.promptName,
      prompt_version:
        typeof eventData.promptVersion === "string"
          ? parseInt(eventData.promptVersion, 10)
          : (eventData.promptVersion ?? null),

      // Model
      model_id: generationUsage?.internal_model_id || "",
      provided_model_name: eventData.modelName,
      model_parameters: eventData.modelParameters
        ? typeof eventData.modelParameters === "string"
          ? JSON.parse(eventData.modelParameters)
          : eventData.modelParameters
        : {},

      // Usage & Cost
      provided_usage_details: eventData.providedUsageDetails ?? {},
      usage_details:
        generationUsage?.usage_details ?? eventData.usageDetails ?? {},
      provided_cost_details: eventData.providedCostDetails ?? {},
      cost_details:
        generationUsage?.cost_details ?? eventData.costDetails ?? {},
      total_cost: generationUsage?.total_cost ?? null,

      usage_pricing_tier_id: generationUsage?.usage_pricing_tier_id,
      usage_pricing_tier_name: generationUsage?.usage_pricing_tier_name,

      // Tool Calls
      tool_definitions: eventData.toolDefinitions ?? {},
      tool_calls: eventData.toolCalls ?? [],
      tool_call_names: eventData.toolCallNames ?? [],

      // I/O
      input: eventData.input,
      output: eventData.output,

      // Metadata (flattened parallel arrays — matches main V4 events_full)
      metadata_names: metadataNames,
      metadata_values: metadataValues,

      // Source/instrumentation metadata
      source: eventData.source,
      service_name: eventData.serviceName,
      service_version: eventData.serviceVersion,
      scope_name: eventData.scopeName,
      scope_version: eventData.scopeVersion,
      telemetry_sdk_language: eventData.telemetrySdkLanguage,
      telemetry_sdk_name: eventData.telemetrySdkName,
      telemetry_sdk_version: eventData.telemetrySdkVersion,

      // Storage
      blob_storage_file_path: fileKey,
      event_bytes: eventData.eventBytes ?? 0,

      // Experiment fields
      experiment_id: eventData.experimentId,
      experiment_name: eventData.experimentName,
      experiment_metadata_names: eventData.experimentMetadataNames ?? [],
      experiment_metadata_values: eventData.experimentMetadataValues ?? [],
      experiment_description: eventData.experimentDescription,
      experiment_dataset_id: eventData.experimentDatasetId,
      experiment_item_id: eventData.experimentItemId,
      experiment_item_version: eventData.experimentItemVersion,
      experiment_item_root_span_id: eventData.experimentItemRootSpanId,
      experiment_item_expected_output: eventData.experimentItemExpectedOutput,
      experiment_item_metadata_names:
        eventData.experimentItemMetadataNames ?? [],
      experiment_item_metadata_values:
        eventData.experimentItemMetadataValues ?? [],

      // System timestamps
      created_at: now,
      updated_at: now,
      event_ts: now,
      is_deleted: 0,
    };

    return eventRecord;
  }

  /**
   * Upsert trace_sessions rows for every distinct sessionId an OTel
   * batch touched. Mirrors upstream langfuse-main's
   * processTraceEventList session upsert (worker/src/services/
   * IngestionService/index.ts) — Phase B/C dropped the path 1 trace
   * processor for OTel observations, so the direct-write caller has
   * to invoke this explicitly after writeEventRecord. ON CONFLICT
   * DO NOTHING preserves UI-set flags (public, bookmarked) on
   * subsequent batches for the same session.
   */
  public async upsertTraceSessions(params: {
    projectId: string;
    sessions: Array<{ id: string; environment: string }>;
  }): Promise<void> {
    const { projectId, sessions } = params;
    if (sessions.length === 0) return;
    for (const s of sessions) {
      try {
        await this.prisma.$executeRaw`
          INSERT INTO trace_sessions (id, project_id, environment, created_at, updated_at)
          VALUES (${s.id}, ${projectId}, ${s.environment}, NOW(), NOW())
          ON CONFLICT (id, project_id)
          DO NOTHING
        `;
      } catch (e) {
        logger.error(
          `Failed to upsert trace_session ${s.id} for project ${projectId}`,
          e,
        );
        throw e;
      }
    }
  }

  /**
   * Writes an event record directly to the events_full table.
   * Use createEventRecord() first to get the record, then call this to write.
   *
   * Doris UNIQUE KEY + Merge-on-Write resolves conflicts by load order;
   * this direct-write path is for OTel-only event payloads that the
   * OTel processor already pre-merged in memory, so it skips the
   * IngestionService pre-read/merge cycle that the SDK path uses.
   *
   * @param eventRecord - The event record to write
   */
  public writeEventRecord(eventRecord: EventRecordInsertType): void {
    if (!this.dorisWriter) {
      logger.debug(
        "writeEventRecord called but DorisWriter is not configured, skipping",
      );
      return;
    }
    this.dorisWriter.addToQueue(TableName.EventsFull, eventRecord);
  }

  /**
   * Direct-write Langfuse-native trace/observation batches into
   * observation-shaped events_full rows. This is the Litefuse-native
   * shape: no synthetic `t-<trace_id>` rows, root observations use
   * `parent_span_id = ''`, and trace-level fields are denormalized onto
   * the written row(s).
   */
  public async directWriteTraceObservationEvents(params: {
    projectId: string;
    createdAtTimestamp: Date;
    events: Array<TraceEventType | ObservationEvent>;
    source: string;
  }): Promise<void> {
    const { projectId, createdAtTimestamp, events, source } = params;
    if (events.length === 0) return;

    const traceEvents = events.filter(
      (event): event is TraceEventType =>
        event.type === eventTypes.TRACE_CREATE,
    );
    const observationEvents = events.filter(
      (event): event is ObservationEvent =>
        event.type !== eventTypes.TRACE_CREATE,
    );

    const traceContext = this.mergeDirectTraceContext(traceEvents);
    const traceId =
      traceContext?.traceId ??
      observationEvents.find(
        (event) => "traceId" in event.body && event.body.traceId,
      )?.body.traceId ??
      observationEvents[0]?.body.id;

    if (!traceId) {
      logger.warn(
        `[IngestionService] Skipping direct native write without traceId for project ${projectId}`,
      );
      return;
    }

    const observationGroups = observationEvents.reduce(
      (acc, event) => {
        const entityId = event.body.id;
        if (!entityId) return acc;
        if (!acc[entityId]) acc[entityId] = [];
        acc[entityId].push(event);
        return acc;
      },
      {} as Record<string, ObservationEvent[]>,
    );

    let hasRootObservation = false;
    let writeCount = 0;

    await Promise.all(
      Object.entries(observationGroups).map(async ([entityId, eventList]) => {
        const eventRecord =
          await this.createDirectEventRecordFromObservationEvents({
            projectId,
            entityId,
            createdAtTimestamp,
            observationEventList: eventList,
            traceContext,
            source,
          });

        if (!eventRecord) return;

        hasRootObservation ||= eventRecord.parent_span_id === "";
        this.writeEventRecord(eventRecord);
        writeCount += 1;
      }),
    );

    // Preserve trace-only writes, e.g. POST /api/public/traces for
    // session creation, by materializing a root observation row only
    // when the batch has no real root observation.
    if (traceContext && !hasRootObservation) {
      const rootTraceRecord = await this.createDirectRootTraceEventRecord({
        projectId,
        traceContext,
        createdAtTimestamp,
        source,
      });
      this.writeEventRecord(rootTraceRecord);
      writeCount += 1;
    }

    if (traceContext?.sessionId) {
      await this.upsertTraceSessions({
        projectId,
        sessions: [
          {
            id: traceContext.sessionId,
            environment: traceContext.environment ?? "default",
          },
        ],
      });
    }

    if (writeCount > 0) {
      recordIncrement("langfuse.ingestion.write", writeCount, {
        object: "observation",
        backend: "doris",
        target: "events_full",
      });
    }
  }

  private async processDatasetRunItemEventList(params: {
    projectId: string;
    entityId: string;
    createdAtTimestamp: Date;
    datasetRunItemEventList: DatasetRunItemEventType[];
  }) {
    const { projectId, entityId, datasetRunItemEventList } = params;
    logger.info(
      `[IngestionService] processDatasetRunItemEventList called for project ${projectId}, entityId ${entityId}, events count: ${datasetRunItemEventList.length}`,
    );
    if (datasetRunItemEventList.length === 0) return;

    const finalDatasetRunItemRecords: DatasetRunItemRecordInsertType[] = (
      await Promise.all(
        datasetRunItemEventList.map(
          async (
            event: DatasetRunItemEventType,
          ): Promise<DatasetRunItemRecordInsertType[]> => {
            const [runData, itemData] = await Promise.all([
              this.prisma.datasetRuns.findFirst({
                where: {
                  id: event.body.runId,
                  datasetId: event.body.datasetId,
                  projectId,
                },
                select: {
                  name: true,
                  description: true,
                  metadata: true,
                  createdAt: true,
                },
              }),
              await getDatasetItemById({
                projectId,
                datasetItemId: event.body.datasetItemId,
                datasetId: event.body.datasetId,
                version: event.body.datasetVersion
                  ? new Date(event.body.datasetVersion)
                  : undefined,
                status: "ACTIVE",
              }),
            ]);

            if (!runData || !itemData) return [];

            const timestamp = event.body.createdAt
              ? new Date(event.body.createdAt).getTime()
              : new Date().getTime();

            const datasetItemVersion = itemData.validFrom
              ? itemData.validFrom.getTime()
              : null;

            return [
              {
                id: entityId,
                project_id: projectId,
                dataset_run_id: event.body.runId,
                dataset_item_id: event.body.datasetItemId,
                dataset_id: event.body.datasetId,
                trace_id: event.body.traceId,
                observation_id: event.body.observationId,
                error: event.body.error,
                created_at: timestamp,
                updated_at: timestamp,
                event_ts: timestamp,
                is_deleted: 0,
                // enriched with run data
                dataset_run_name: runData.name,
                dataset_run_description: runData.description,
                dataset_run_metadata: runData.metadata
                  ? convertPostgresJsonToMetadataRecord(runData.metadata)
                  : {},
                dataset_run_created_at: runData.createdAt.getTime(),
                // enriched with item data
                dataset_item_version: datasetItemVersion,
                dataset_item_input: JSON.stringify(itemData.input),
                dataset_item_expected_output: JSON.stringify(
                  itemData.expectedOutput,
                ),
                dataset_item_metadata: itemData.metadata
                  ? convertPostgresJsonToMetadataRecord(itemData.metadata)
                  : {},
              },
            ];
          },
        ),
      )
    ).flat();

    if (finalDatasetRunItemRecords.length > 0 && this.dorisWriter) {
      // Write DatasetRunItem records to the injected writer
      logger.info(
        `[IngestionService] Adding ${finalDatasetRunItemRecords.length} DatasetRunItem records to writer`,
      );
      for (const record of finalDatasetRunItemRecords) {
        this.dorisWriter.addToQueue(TableName.DatasetRunItems, record);
      }
    }
  }

  private async processScoreEventList(params: {
    projectId: string;
    entityId: string;
    createdAtTimestamp: Date;
    scoreEventList: ScoreEventType[];
  }) {
    const { projectId, entityId, createdAtTimestamp, scoreEventList } = params;
    if (scoreEventList.length === 0) return;

    const timeSortedEvents =
      IngestionService.toTimeSortedEventList(scoreEventList);

    const minTimestamp = Math.min(
      ...timeSortedEvents.flatMap((e) =>
        e.timestamp ? [new Date(e.timestamp).getTime()] : [],
      ),
    );
    const timestamp =
      minTimestamp === Infinity
        ? undefined
        : convertDateToAnalyticsDateTime(new Date(minTimestamp));
    const [existingScoreRecord, scoreRecords] = await Promise.all([
      this.getAnalyticsRecord({
        projectId,
        entityId,
        table: TableName.Scores,
        additionalFilters: {
          whereCondition: timestamp
            ? " AND timestamp >= {timestamp: DateTime64(3)} "
            : "",
          params: { timestamp },
        },
      }),
      Promise.all(
        timeSortedEvents.map(async (scoreEvent) => {
          try {
            const validatedScore = await validateAndInflateScore({
              body: scoreEvent.body,
              scoreId: entityId,
              projectId,
            });

            return {
              id: entityId,
              project_id: projectId,
              environment: validatedScore.environment,
              timestamp: this.getMillisecondTimestamp(scoreEvent.timestamp),
              name: validatedScore.name,
              value: validatedScore.value,
              source: validatedScore.source,
              trace_id: validatedScore.traceId,
              session_id: validatedScore.sessionId,
              dataset_run_id: validatedScore.datasetRunId,
              data_type: validatedScore.dataType,
              observation_id: validatedScore.observationId,
              config_id: validatedScore.configId,
              comment: validatedScore.comment,
              metadata: scoreEvent.body.metadata
                ? convertJsonSchemaToRecord(scoreEvent.body.metadata)
                : {},
              string_value: validatedScore.stringValue,
              long_string_value: validatedScore.longStringValue,
              execution_trace_id: validatedScore.executionTraceId,
              queue_id: validatedScore.queueId ?? null,
              created_at: Date.now(),
              updated_at: Date.now(),
              event_ts: new Date(scoreEvent.timestamp).getTime(),
              is_deleted: 0,
            };
            // Gracefully handle any score schema validation errors, skip the score insert and reject silently.
          } catch (error) {
            logger.info(
              `Failed to validate and enrich score body for project: ${projectId} and score: ${entityId}`,
              error,
            );
            return null;
          }
        }),
      ).then((results) =>
        results.filter(
          (record): record is NonNullable<typeof record> => record !== null,
        ),
      ),
    ]);

    if (existingScoreRecord) {
      recordIncrement("langfuse.ingestion.lookup.hit", 1, {
        store: env.LITEFUSE_ANALYTICS_BACKEND,
        object: "score",
      });
    }

    const finalScoreRecord: ScoreRecordInsertType =
      await this.mergeScoreRecords({
        dorisScoreRecord: existingScoreRecord,
        scoreRecords,
      });
    finalScoreRecord.created_at =
      existingScoreRecord?.created_at ?? createdAtTimestamp.getTime();

    // Write to Doris backend
    if (this.dorisWriter) {
      this.dorisWriter.addToQueue(TableName.Scores, finalScoreRecord);
    }
  }

  private async processTraceEventList(params: {
    projectId: string;
    entityId: string;
    createdAtTimestamp: Date;
    traceEventList: TraceEventType[];
  }) {
    const { projectId, entityId, createdAtTimestamp, traceEventList } = params;
    if (traceEventList.length === 0) return;

    const timeSortedEvents =
      IngestionService.toTimeSortedEventList(traceEventList);

    const traceRecords = this.mapTraceEventsToRecords({
      projectId,
      entityId,
      traceEventList: timeSortedEvents,
    });

    // Search for the first non-null input and output in the trace events
    // and set them on the merged result.
    const reversedRawRecords = timeSortedEvents.slice().reverse();
    const finalIO = {
      input: this.stringify(
        reversedRawRecords.find((record) => record?.body?.input)?.body?.input,
      ),
      output: this.stringify(
        reversedRawRecords.find((record) => record?.body?.output)?.body?.output,
      ),
    };

    // In-batch merge only. Under OTel-only the events list has length
    // 1 (one OTel span → one trace-create event, deduped per request by
    // OtelIngestionProcessor.seenTraces), so this collapses to identity.
    // Kept for symmetry with the upstream signature and to remain safe
    // if a future caller groups multiple events for the same trace_id
    // within one batch.
    const finalTraceRecord = await this.mergeTraceRecords({ traceRecords });
    finalTraceRecord.created_at = createdAtTimestamp.getTime();
    if (finalIO.input != null) finalTraceRecord.input = finalIO.input;
    if (finalIO.output != null) finalTraceRecord.output = finalIO.output;

    // OTel-only Lightweight: no cross-batch pre-read needed. v4/v5 SDKs
    // emit one OTel span = one HTTP request with all attributes inlined,
    // and `OtelIngestionProcessor.processToIngestionEvents` dedupes
    // trace-create events per HTTP request via `seenTraces`, so for any
    // given (project_id, span_id) at most one row reaches this code path
    // per request. Doris UNIQUE KEY + MoW resolves cross-request retries
    // by load order (replays carry the same payload). The old pre-read
    // + per-column merge was defense against the v3 create/update split
    // protocol, which the OTel route now rejects at the entrypoint.
    const spanId = `t-${entityId}`;
    const eventRecord = this.buildEventFullFromTrace({
      traceRecord: finalTraceRecord,
      spanId,
      source: "api",
    });

    if (this.dorisWriter) {
      this.dorisWriter.addToQueue(TableName.EventsFull, eventRecord);
      logger.debug(
        `Added trace span ${spanId} to events_full queue for project ${projectId}`,
      );
    }

    recordIncrement("langfuse.ingestion.write", 1, {
      object: "trace",
      backend: "doris",
      target: "events_full",
    });

    // If the trace has a sessionId, upsert the session into Postgres.
    const traceRecordWithSession = traceRecords
      .slice()
      .reverse()
      .find((t) => t.session_id);
    if (traceRecordWithSession) {
      try {
        await this.prisma.$executeRaw`
          INSERT INTO trace_sessions (id, project_id, environment, created_at, updated_at)
          VALUES (${traceRecordWithSession.session_id}, ${projectId}, ${traceRecordWithSession.environment}, NOW(), NOW())
          ON CONFLICT (id, project_id)
          DO NOTHING
        `;
      } catch (e) {
        logger.error(
          `Failed to upsert session ${traceRecordWithSession.session_id}`,
          e,
        );
        throw e;
      }
    }

    // Schedule eval processing if the project has trace-based job configs.
    const hasNoJobConfigs = await hasNoEvalConfigsCache(
      projectId,
      "traceBased",
    );
    if (hasNoJobConfigs) {
      logger.debug(
        `Skipping TraceUpsert queue for project ${projectId} - no job configs cached`,
      );
      return;
    }

    // Schedule trace-upsert eval via pg-boss. The Doris fork ran this on
    // BullMQ (sharded by projectId-traceId); pg-boss has no sharding,
    // so we use singletonKey to dedupe rapid-fire updates to the same
    // trace into a single eval-trigger job (1s window). This is
    // strictly better than the previous behaviour, which used a random
    // jobId and therefore never deduped at all.
    try {
      await enqueuePgBossJob(
        QueueName.TraceUpsert,
        QueueJobs.TraceUpsert,
        {
          projectId,
          traceId: entityId,
          exactTimestamp: new Date(finalTraceRecord.timestamp).toISOString(),
          traceEnvironment: finalTraceRecord.environment,
        },
        {
          singletonKey: `trace-upsert:${projectId}:${entityId}`,
          singletonSeconds: 1,
        },
      );
    } catch (err) {
      logger.error(
        `Failed to enqueue trace-upsert eval job for ${projectId}:${entityId}`,
        err,
      );
    }
  }

  private async processObservationEventList(params: {
    projectId: string;
    entityId: string;
    createdAtTimestamp: Date;
    observationEventList: ObservationEvent[];
  }) {
    const { projectId, entityId, createdAtTimestamp, observationEventList } =
      params;
    if (observationEventList.length === 0) return;

    const timeSortedEvents =
      IngestionService.toTimeSortedEventList(observationEventList);

    const prompt = await this.getPrompt(projectId, observationEventList);

    const observationRecords = this.mapObservationEventsToRecords({
      observationEventList: timeSortedEvents,
      projectId,
      entityId,
      prompt,
    });

    // In-batch merge only. Cross-batch correctness lives in the full-row
    // pre-read + per-column merge below; Doris MoW just resolves by load
    // order since the writer always sends the post-merge state.
    const mergedObservationRecord = await this.mergeObservationRecords({
      observationRecords,
    });
    mergedObservationRecord.created_at = createdAtTimestamp.getTime();
    mergedObservationRecord.level = mergedObservationRecord.level ?? "DEFAULT";

    // Resolve raw input/output from the batch events (most recent non-null).
    const reversedRawRecords = timeSortedEvents.slice().reverse();
    const rawInput = reversedRawRecords.find((record) => record?.body?.input)
      ?.body?.input;
    if (rawInput != null) {
      mergedObservationRecord.input = this.stringify(rawInput);
    }

    const rawOutput = reversedRawRecords.find((record) => record?.body?.output)
      ?.body?.output;
    if (rawOutput != null) {
      mergedObservationRecord.output = this.stringify(rawOutput);
    }

    // Extract tool definitions and calls from raw input/output.
    try {
      const { toolDefinitions, toolArguments } = extractToolsFromObservation(
        rawInput,
        rawOutput,
      );

      if (toolDefinitions.length > 0) {
        mergedObservationRecord.tool_definitions =
          convertDefinitionsToMap(toolDefinitions);
      }

      if (toolArguments.length > 0) {
        const { tool_calls, tool_call_names } =
          convertCallsToArrays(toolArguments);
        mergedObservationRecord.tool_calls = tool_calls;
        mergedObservationRecord.tool_call_names = tool_call_names;
      }
    } catch (error) {
      logger.error("Tool extraction failed", { error, projectId, entityId });
      // Don't fail ingestion - just skip tool data.
    }

    // Tokenisation must see the most recent raw input/output payload
    // from the batch, not a stale partially merged field.
    const generationUsage = await this.getGenerationUsage({
      projectId,
      observationRecord: {
        ...mergedObservationRecord,
        input:
          rawInput != null
            ? this.stringify(rawInput)
            : mergedObservationRecord.input,
        output:
          rawOutput != null
            ? this.stringify(rawOutput)
            : mergedObservationRecord.output,
      },
    });
    const finalObservationRecord = {
      ...mergedObservationRecord,
      ...generationUsage,
    };

    // Backward compat: SDK < 2.0.0 events arrive without a traceId. Synthesize
    // a trace where trace_id = observation.id and emit a synthetic trace span
    // to events_full so the row is discoverable in trace lists.
    if (!finalObservationRecord.trace_id) {
      finalObservationRecord.trace_id = finalObservationRecord.id;
      const syntheticTraceSpan = this.buildSyntheticTraceSpanForOrphan({
        projectId,
        traceId: finalObservationRecord.id,
        startTimeMs: finalObservationRecord.start_time,
        environment: finalObservationRecord.environment,
      });
      if (this.dorisWriter) {
        this.dorisWriter.addToQueue(TableName.EventsFull, syntheticTraceSpan);
      }
    }

    // OTel-only Lightweight: no cross-batch pre-read. See the matching
    // comment in processTraceEventList for the full rationale — single
    // OTel span = single complete write, Doris MoW handles retries by
    // load order, pre-v4 protocol's create/update split is rejected at
    // the OTel route entrypoint.
    const eventRecord = this.buildEventFullFromObservation({
      observationRecord: finalObservationRecord,
      source: "api",
    });

    if (this.dorisWriter) {
      this.dorisWriter.addToQueue(TableName.EventsFull, eventRecord);
    }

    recordIncrement("langfuse.ingestion.write", 1, {
      object: "observation",
      backend: "doris",
      target: "events_full",
    });
  }

  private async mergeScoreRecords(params: {
    scoreRecords: ScoreRecordInsertType[];
    dorisScoreRecord?: ScoreRecordInsertType | null;
  }): Promise<ScoreRecordInsertType> {
    const { scoreRecords, dorisScoreRecord } = params;

    // Set doris record first as this is the baseline for immutable fields
    const recordsToMerge = [dorisScoreRecord, ...scoreRecords].filter(
      Boolean,
    ) as ScoreRecordInsertType[];

    const mergedRecord = this.mergeRecords(
      recordsToMerge,
      immutableEntityKeys[TableName.Scores],
    );

    // If metadata exists, it is an object due to previous parsing
    mergedRecord.metadata = convertRecordValuesToString(
      (mergedRecord.metadata as Record<string, unknown>) ?? {},
    );

    return scoreRecordInsertSchema.parse(mergedRecord);
  }

  private async mergeTraceRecords(params: {
    traceRecords: TraceRecordInsertType[];
  }): Promise<TraceRecordInsertType> {
    const { traceRecords } = params;

    const mergedRecord = this.mergeRecords(
      traceRecords,
      immutableEntityKeys[TableName.Traces],
    );

    // If metadata exists, it is an object due to previous parsing
    mergedRecord.metadata = convertRecordValuesToString(
      (mergedRecord.metadata as Record<string, unknown>) ?? {},
    );

    return traceRecordInsertSchema.parse(mergedRecord);
  }

  private async mergeObservationRecords(params: {
    observationRecords: ObservationRecordInsertType[];
  }): Promise<ObservationRecordInsertType> {
    const { observationRecords } = params;

    const mergedRecord = this.mergeRecords(
      observationRecords,
      immutableEntityKeys[TableName.Observations],
    );

    // If metadata exists, it is an object due to previous parsing
    mergedRecord.metadata = convertRecordValuesToString(
      (mergedRecord.metadata as Record<string, unknown>) ?? {},
    );

    const parsedObservationRecord =
      observationRecordInsertSchema.parse(mergedRecord);

    // Override endTimes that are before startTimes with the startTime
    if (
      parsedObservationRecord.end_time &&
      parsedObservationRecord.end_time < parsedObservationRecord.start_time
    ) {
      parsedObservationRecord.end_time = parsedObservationRecord.start_time;
    }

    return parsedObservationRecord;
  }

  private mergeRecords<T extends InsertRecord>(
    records: T[],
    immutableEntityKeys: string[],
  ): Record<string, unknown> {
    if (records.length === 0) {
      throw new Error("No records to merge");
    }

    let result: {
      id: string;
      project_id: string;
      [key: string]: any;
    } = { id: records[0].id, project_id: records[0].project_id };

    for (const record of records) {
      result = overwriteObject(result, record, immutableEntityKeys);
    }

    result.event_ts = new Date().getTime();

    return result;
  }

  private static toTimeSortedEventList<
    T extends TraceEventType | ScoreEventType | ObservationEvent,
  >(eventList: T[]): T[] {
    return eventList.slice().sort((a, b) => {
      const aIsCreate = a.type.includes("create");
      const bIsCreate = b.type.includes("create");

      // Create events always come before update events regardless of timestamp.
      // The Langfuse SDK's enqueue() uses fire-and-forget async processing, so
      // a large create body (with input/output) can finish later than a small
      // update body, giving the create event a later timestamp.  Sorting purely
      // by timestamp would then place updates before create, causing the merge's
      // immutable-key protection to lock in the update's wrong start_time.
      if (aIsCreate !== bIsCreate) {
        return aIsCreate ? -1 : 1;
      }

      const aTimestamp = new Date(a.timestamp).getTime();
      const bTimestamp = new Date(b.timestamp).getTime();

      return aTimestamp - bTimestamp;
    });
  }

  /**
   * Build the events_full row for a synthetic trace span (span_id = 't-' + traceId).
   * OTel-only Lightweight: no prior-row merge; the metadata + tags come
   * straight from the (single) trace record produced for this request.
   */
  private buildEventFullFromTrace(params: {
    traceRecord: TraceRecordInsertType;
    spanId: string;
    source: string;
  }): EventRecordInsertType {
    const { traceRecord, spanId, source } = params;
    const flatten = flattenJsonToPathArrays(traceRecord.metadata ?? {});
    // Sort for deterministic Stream Load payloads (helps log diffing and
    // makes Doris partial-column grouping stable should we ever re-enable
    // it).
    const sortedMetadata = sortFlatMetadata(flatten.names, flatten.values);
    const sortedTags = Array.from(new Set(traceRecord.tags ?? [])).sort();
    const now = Date.now();
    return {
      id: spanId,
      project_id: traceRecord.project_id,
      trace_id: traceRecord.id,
      span_id: spanId,
      parent_span_id: "",
      name: traceRecord.name ?? "",
      type: "SPAN",
      environment: traceRecord.environment,
      version: traceRecord.version ?? null,
      release: traceRecord.release ?? null,
      trace_name: traceRecord.name ?? null,
      user_id: traceRecord.user_id ?? null,
      session_id: traceRecord.session_id ?? null,
      tags: sortedTags,
      bookmarked: traceRecord.bookmarked ?? false,
      public: traceRecord.public ?? false,
      level: "DEFAULT",
      status_message: null,
      start_time: traceRecord.timestamp,
      end_time: null,
      completion_start_time: null,
      prompt_id: null,
      prompt_name: null,
      prompt_version: null,
      model_id: null,
      provided_model_name: null,
      model_parameters: null,
      provided_usage_details: {},
      usage_details: {},
      provided_cost_details: {},
      cost_details: {},
      total_cost: null,
      usage_pricing_tier_id: null,
      usage_pricing_tier_name: null,
      tool_definitions: {},
      tool_calls: [],
      tool_call_names: [],
      input: traceRecord.input ?? null,
      output: traceRecord.output ?? null,
      metadata_names: sortedMetadata.names,
      metadata_values: sortedMetadata.values,
      experiment_id: null,
      experiment_name: null,
      experiment_metadata_names: [],
      experiment_metadata_values: [],
      experiment_description: null,
      experiment_dataset_id: null,
      experiment_item_id: null,
      experiment_item_version: null,
      experiment_item_expected_output: null,
      experiment_item_metadata_names: [],
      experiment_item_metadata_values: [],
      experiment_item_root_span_id: null,
      source,
      service_name: null,
      service_version: null,
      scope_name: null,
      scope_version: null,
      telemetry_sdk_language: null,
      telemetry_sdk_name: null,
      telemetry_sdk_version: null,
      blob_storage_file_path: "",
      event_bytes: 0,
      created_at: traceRecord.created_at,
      updated_at: now,
      event_ts: now,
      is_deleted: 0,
    };
  }

  /**
   * Build the events_full row for an observation span. Trace-level fields
   * (user_id, session_id, tags, release, trace_name, bookmarked, public)
   * live on the synthetic trace span (span_id='t-'+trace_id) and are NOT
   * backfilled onto observation rows in this version — UI queries can JOIN.
   *
   * OTel-only Lightweight: no prior-row merge; metadata comes straight
   * from the single observation record.
   */
  private buildEventFullFromObservation(params: {
    observationRecord: ObservationRecordInsertType;
    source: string;
  }): EventRecordInsertType {
    const { observationRecord: obs, source } = params;
    const flatten = flattenJsonToPathArrays(obs.metadata ?? {});
    const sortedMetadata = sortFlatMetadata(flatten.names, flatten.values);
    const now = Date.now();
    const parentSpanId =
      obs.parent_observation_id && obs.parent_observation_id.length > 0
        ? obs.parent_observation_id
        : obs.trace_id
          ? `t-${obs.trace_id}`
          : "";
    // Trace-level denormalised fields (user_id/session_id/trace_name/tags/
    // release/bookmarked/public/environment) are intentionally left NULL on
    // observation rows in this legacy merge path. Read-side trace-level
    // enrichment is handled separately; this still avoids a Doris point-
    // lookup on every observation write.
    return {
      id: obs.id,
      project_id: obs.project_id,
      trace_id: obs.trace_id ?? "",
      span_id: obs.id,
      parent_span_id: parentSpanId,
      name: obs.name ?? "",
      type: obs.type,
      environment: obs.environment,
      version: obs.version ?? null,
      release: null,
      trace_name: null,
      user_id: null,
      session_id: null,
      tags: [],
      bookmarked: false,
      public: false,
      level: obs.level ?? "DEFAULT",
      status_message: obs.status_message ?? null,
      start_time: obs.start_time,
      end_time: obs.end_time ?? null,
      completion_start_time: obs.completion_start_time ?? null,
      prompt_id: obs.prompt_id ?? null,
      prompt_name: obs.prompt_name ?? null,
      prompt_version: obs.prompt_version ?? null,
      model_id: obs.internal_model_id ?? null,
      provided_model_name: obs.provided_model_name ?? null,
      model_parameters: obs.model_parameters ?? null,
      provided_usage_details: obs.provided_usage_details ?? {},
      usage_details: obs.usage_details ?? {},
      provided_cost_details: obs.provided_cost_details ?? {},
      cost_details: obs.cost_details ?? {},
      total_cost: obs.total_cost ?? null,
      usage_pricing_tier_id: obs.usage_pricing_tier_id ?? null,
      usage_pricing_tier_name: obs.usage_pricing_tier_name ?? null,
      tool_definitions: obs.tool_definitions ?? {},
      tool_calls: obs.tool_calls ?? [],
      tool_call_names: obs.tool_call_names ?? [],
      input: obs.input ?? null,
      output: obs.output ?? null,
      metadata_names: sortedMetadata.names,
      metadata_values: sortedMetadata.values,
      experiment_id: null,
      experiment_name: null,
      experiment_metadata_names: [],
      experiment_metadata_values: [],
      experiment_description: null,
      experiment_dataset_id: null,
      experiment_item_id: null,
      experiment_item_version: null,
      experiment_item_expected_output: null,
      experiment_item_metadata_names: [],
      experiment_item_metadata_values: [],
      experiment_item_root_span_id: null,
      source,
      service_name: null,
      service_version: null,
      scope_name: null,
      scope_version: null,
      telemetry_sdk_language: null,
      telemetry_sdk_name: null,
      telemetry_sdk_version: null,
      blob_storage_file_path: "",
      event_bytes: 0,
      created_at: obs.created_at,
      updated_at: now,
      event_ts: now,
      is_deleted: 0,
    };
  }

  /**
   * SDK < 2.0.0 observations arrive without a trace_id. We synthesize a
   * trace where trace_id = observation.id and emit a minimal trace span
   * row to events_full so the row is discoverable by trace-list queries.
   */
  private buildSyntheticTraceSpanForOrphan(params: {
    projectId: string;
    traceId: string;
    startTimeMs: number;
    environment: string;
  }): EventRecordInsertType {
    const now = Date.now();
    const spanId = `t-${params.traceId}`;
    return {
      id: spanId,
      project_id: params.projectId,
      trace_id: params.traceId,
      span_id: spanId,
      parent_span_id: "",
      name: "",
      type: "SPAN",
      environment: params.environment,
      version: null,
      release: null,
      trace_name: null,
      user_id: null,
      session_id: null,
      tags: [],
      bookmarked: false,
      public: false,
      level: "DEFAULT",
      status_message: null,
      start_time: params.startTimeMs,
      end_time: null,
      completion_start_time: null,
      prompt_id: null,
      prompt_name: null,
      prompt_version: null,
      model_id: null,
      provided_model_name: null,
      model_parameters: null,
      provided_usage_details: {},
      usage_details: {},
      provided_cost_details: {},
      cost_details: {},
      total_cost: null,
      usage_pricing_tier_id: null,
      usage_pricing_tier_name: null,
      tool_definitions: {},
      tool_calls: [],
      tool_call_names: [],
      input: null,
      output: null,
      metadata_names: [],
      metadata_values: [],
      experiment_id: null,
      experiment_name: null,
      experiment_metadata_names: [],
      experiment_metadata_values: [],
      experiment_description: null,
      experiment_dataset_id: null,
      experiment_item_id: null,
      experiment_item_version: null,
      experiment_item_expected_output: null,
      experiment_item_metadata_names: [],
      experiment_item_metadata_values: [],
      experiment_item_root_span_id: null,
      source: "api",
      service_name: null,
      service_version: null,
      scope_name: null,
      scope_version: null,
      telemetry_sdk_language: null,
      telemetry_sdk_name: null,
      telemetry_sdk_version: null,
      blob_storage_file_path: "",
      event_bytes: 0,
      created_at: now,
      updated_at: now,
      event_ts: now,
      is_deleted: 0,
    };
  }

  private mergeDirectTraceContext(
    traceEvents: TraceEventType[],
  ): DirectTraceContext | null {
    if (traceEvents.length === 0) return null;

    const timeSortedEvents =
      IngestionService.toTimeSortedEventList(traceEvents);
    let result: DirectTraceContext = {
      traceId: "",
      environment: "default",
      metadata: {},
      public: false,
      tags: [],
    };

    for (const event of timeSortedEvents) {
      const body = event.body;
      const nextMetadata = body.metadata
        ? convertJsonSchemaToRecord(body.metadata)
        : {};

      result = {
        traceId: body.id ?? result.traceId,
        timestamp: body.timestamp ?? result.timestamp ?? null,
        name: body.name ?? result.name ?? null,
        input: body.input ?? result.input,
        output: body.output ?? result.output,
        sessionId: body.sessionId ?? result.sessionId ?? null,
        userId: body.userId ?? result.userId ?? null,
        environment: body.environment ?? result.environment ?? "default",
        metadata: {
          ...(result.metadata ?? {}),
          ...nextMetadata,
        },
        release: body.release ?? result.release ?? null,
        version: body.version ?? result.version ?? null,
        public: body.public ?? result.public ?? false,
        tags: Array.from(
          new Set([...(result.tags ?? []), ...(body.tags ?? [])]),
        ).sort(),
      };
    }

    return result.traceId ? result : null;
  }

  private async createDirectEventRecordFromObservationEvents(params: {
    projectId: string;
    entityId: string;
    createdAtTimestamp: Date;
    observationEventList: ObservationEvent[];
    traceContext: DirectTraceContext | null;
    source: string;
  }): Promise<EventRecordInsertType | null> {
    const {
      projectId,
      entityId,
      createdAtTimestamp,
      observationEventList,
      traceContext,
      source,
    } = params;
    if (observationEventList.length === 0) return null;

    const timeSortedEvents =
      IngestionService.toTimeSortedEventList(observationEventList);

    const prompt = await this.getPrompt(projectId, observationEventList);
    const observationRecords = this.mapObservationEventsToRecords({
      observationEventList: timeSortedEvents,
      projectId,
      entityId,
      prompt,
    });

    const mergedObservationRecord = await this.mergeObservationRecords({
      observationRecords,
    });
    mergedObservationRecord.created_at = createdAtTimestamp.getTime();
    mergedObservationRecord.level = mergedObservationRecord.level ?? "DEFAULT";

    const reversedRawRecords = timeSortedEvents.slice().reverse();
    const rawInput = reversedRawRecords.find((record) => record?.body?.input)
      ?.body?.input;
    if (rawInput != null) {
      mergedObservationRecord.input = this.stringify(rawInput);
    }

    const rawOutput = reversedRawRecords.find((record) => record?.body?.output)
      ?.body?.output;
    if (rawOutput != null) {
      mergedObservationRecord.output = this.stringify(rawOutput);
    }

    try {
      const { toolDefinitions, toolArguments } = extractToolsFromObservation(
        rawInput,
        rawOutput,
      );

      if (toolDefinitions.length > 0) {
        mergedObservationRecord.tool_definitions =
          convertDefinitionsToMap(toolDefinitions);
      }

      if (toolArguments.length > 0) {
        const { tool_calls, tool_call_names } =
          convertCallsToArrays(toolArguments);
        mergedObservationRecord.tool_calls = tool_calls;
        mergedObservationRecord.tool_call_names = tool_call_names;
      }
    } catch (error) {
      logger.error("Tool extraction failed", { error, projectId, entityId });
    }

    const traceId =
      mergedObservationRecord.trace_id ??
      traceContext?.traceId ??
      mergedObservationRecord.id;
    const isRootObservation = !mergedObservationRecord.parent_observation_id;
    const fallbackTraceInput = isRootObservation
      ? this.stringify(traceContext?.input)
      : undefined;
    const fallbackTraceOutput = isRootObservation
      ? this.stringify(traceContext?.output)
      : undefined;
    const metadata = {
      ...(traceContext?.metadata ?? {}),
      ...(mergedObservationRecord.metadata ?? {}),
    };

    return this.createEventRecord(
      {
        projectId,
        traceId,
        spanId: mergedObservationRecord.id,
        parentSpanId:
          mergedObservationRecord.parent_observation_id ?? undefined,
        name:
          mergedObservationRecord.name ?? traceContext?.name ?? "observation",
        type: mergedObservationRecord.type,
        environment:
          mergedObservationRecord.environment ??
          traceContext?.environment ??
          "default",
        version:
          mergedObservationRecord.version ?? traceContext?.version ?? undefined,
        release: traceContext?.release ?? undefined,
        startTimeISO: new Date(
          mergedObservationRecord.start_time,
        ).toISOString(),
        endTimeISO: new Date(
          mergedObservationRecord.end_time ??
            mergedObservationRecord.start_time,
        ).toISOString(),
        completionStartTime: mergedObservationRecord.completion_start_time
          ? new Date(
              mergedObservationRecord.completion_start_time,
            ).toISOString()
          : undefined,
        traceName:
          traceContext?.name ??
          (isRootObservation
            ? (mergedObservationRecord.name ?? undefined)
            : undefined),
        tags: traceContext?.tags ?? [],
        bookmarked: false,
        public: traceContext?.public ?? false,
        userId: traceContext?.userId ?? undefined,
        sessionId: traceContext?.sessionId ?? undefined,
        level: mergedObservationRecord.level ?? "DEFAULT",
        statusMessage: mergedObservationRecord.status_message ?? undefined,
        promptName: mergedObservationRecord.prompt_name ?? undefined,
        promptVersion:
          mergedObservationRecord.prompt_version != null
            ? String(mergedObservationRecord.prompt_version)
            : undefined,
        modelName: mergedObservationRecord.provided_model_name ?? undefined,
        modelParameters: mergedObservationRecord.model_parameters ?? undefined,
        providedUsageDetails:
          mergedObservationRecord.provided_usage_details ?? {},
        providedCostDetails:
          mergedObservationRecord.provided_cost_details ?? {},
        toolDefinitions: mergedObservationRecord.tool_definitions ?? {},
        toolCalls: mergedObservationRecord.tool_calls ?? [],
        toolCallNames: mergedObservationRecord.tool_call_names ?? [],
        input: mergedObservationRecord.input ?? fallbackTraceInput,
        output: mergedObservationRecord.output ?? fallbackTraceOutput,
        metadata,
        source,
      },
      "",
    );
  }

  private async createDirectRootTraceEventRecord(params: {
    projectId: string;
    traceContext: DirectTraceContext;
    createdAtTimestamp: Date;
    source: string;
  }): Promise<EventRecordInsertType> {
    const { projectId, traceContext, createdAtTimestamp, source } = params;
    const startTimeISO = (
      traceContext.timestamp ?? createdAtTimestamp.toISOString()
    ).toString();

    return this.createEventRecord(
      {
        projectId,
        traceId: traceContext.traceId,
        spanId: traceContext.traceId,
        parentSpanId: "",
        name: traceContext.name ?? "",
        type: "SPAN",
        environment: traceContext.environment ?? "default",
        version: traceContext.version ?? undefined,
        release: traceContext.release ?? undefined,
        startTimeISO,
        endTimeISO: startTimeISO,
        traceName: traceContext.name ?? undefined,
        tags: traceContext.tags ?? [],
        bookmarked: false,
        public: traceContext.public ?? false,
        userId: traceContext.userId ?? undefined,
        sessionId: traceContext.sessionId ?? undefined,
        level: "DEFAULT",
        input: this.stringify(traceContext.input),
        output: this.stringify(traceContext.output),
        metadata: traceContext.metadata ?? {},
        source,
      },
      "",
    );
  }

  private async getPrompt(
    projectId: string,
    observationEventList: ObservationEvent[],
  ): Promise<ObservationPrompt | null> {
    const lastObservationWithPromptInfo = observationEventList
      .slice()
      .reverse()
      .find(this.hasPromptInformation);

    if (!lastObservationWithPromptInfo) return null;

    const { promptName, promptVersion: version } =
      lastObservationWithPromptInfo.body;

    return this.promptService.getPrompt({
      projectId,
      promptName,
      version,
      label: undefined,
    });
  }

  private hasPromptInformation(
    event: ObservationEvent,
  ): event is ObservationEvent & {
    body: { promptName: string; promptVersion: number };
  } {
    return (
      "promptName" in event.body &&
      typeof event.body.promptName === "string" &&
      "promptVersion" in event.body &&
      typeof event.body.promptVersion === "number"
    );
  }

  private async getGenerationUsage(params: {
    projectId: string;
    observationRecord: Pick<
      ObservationRecordInsertType,
      | "project_id"
      | "trace_id"
      | "id"
      | "provided_model_name"
      | "provided_usage_details"
      | "provided_cost_details"
      | "level"
      | "input"
      | "output"
    >;
  }): Promise<
    Pick<
      ObservationRecordInsertType,
      | "usage_details"
      | "cost_details"
      | "total_cost"
      | "internal_model_id"
      | "usage_pricing_tier_id"
      | "usage_pricing_tier_name"
    >
  > {
    const { projectId, observationRecord } = params;
    const { model: internalModel, pricingTiers } =
      observationRecord.provided_model_name
        ? await findModel({
            projectId,
            model: observationRecord.provided_model_name,
          })
        : { model: null, pricingTiers: [] };

    const final_usage_details = await this.getUsageUnits(
      observationRecord,
      internalModel,
    );

    // Match pricing tier based on usage_details
    let modelPrices: Array<{ usageType: string; price: Decimal }> = [];
    let usage_pricing_tier_id: string | null = null;
    let usage_pricing_tier_name: string | null = null;

    if (pricingTiers.length > 0 && final_usage_details.usage_details) {
      const matchedTier = matchPricingTier(
        pricingTiers,
        final_usage_details.usage_details,
      );

      if (matchedTier) {
        usage_pricing_tier_id = matchedTier.pricingTierId;
        usage_pricing_tier_name = matchedTier.pricingTierName;

        // Convert matched tier prices to simple format for calculateUsageCosts
        modelPrices = Object.entries(matchedTier.prices).map(
          ([usageType, price]) => ({
            usageType,
            price,
          }),
        );
      }
    }

    const final_cost_details = IngestionService.calculateUsageCosts(
      modelPrices,
      observationRecord,
      final_usage_details.usage_details ?? {},
    );

    logger.debug(
      `Calculated costs and usage for observation ${observationRecord.id} with model ${internalModel?.id}`,
      {
        cost: final_cost_details.cost_details,
        usage: final_usage_details.usage_details,
        pricingTier: usage_pricing_tier_name,
      },
    );

    return {
      ...final_usage_details,
      ...final_cost_details,
      internal_model_id: internalModel?.id,
      usage_pricing_tier_id,
      usage_pricing_tier_name,
    };
  }

  private async getUsageUnits(
    observationRecord: Pick<
      ObservationRecordInsertType,
      "provided_usage_details" | "level" | "input" | "output" | "id"
    >,
    model: Model | null | undefined,
  ): Promise<
    Pick<
      ObservationRecordInsertType,
      "usage_details" | "provided_usage_details"
    >
  > {
    // Convert all values to numbers to handle cases where Doris returns UInt64 as strings.
    // This prevents string concatenation bugs like "100" + "200" = "100200" instead of 300.
    const providedUsageDetails: Record<string, number> = {};
    for (const [key, value] of Object.entries(
      observationRecord.provided_usage_details,
    )) {
      if (value != null) {
        const numValue = Number(value);
        if (!isNaN(numValue) && numValue >= 0) {
          providedUsageDetails[key] = numValue;
        }
      }
    }

    if (
      // Manual tokenisation when no user provided usage and generation has not status ERROR
      model &&
      Object.keys(providedUsageDetails).length === 0 &&
      observationRecord.level !== ObservationLevel.ERROR &&
      (this.tokenCountAsync || this.tokenCount)
    ) {
      try {
        let newInputCount: number | undefined;
        let newOutputCount: number | undefined;
        const tokenCountAsync = this.tokenCountAsync;
        const tokenCount = this.tokenCount;
        await instrumentAsync(
          {
            name: "token-count",
          },
          async (span) => {
            try {
              if (tokenCountAsync) {
                [newInputCount, newOutputCount] = await Promise.all([
                  tokenCountAsync({
                    text: observationRecord.input,
                    model,
                  }),
                  tokenCountAsync({
                    text: observationRecord.output,
                    model,
                  }),
                ]);
              } else if (tokenCount) {
                newInputCount = tokenCount({
                  text: observationRecord.input,
                  model,
                });
                newOutputCount = tokenCount({
                  text: observationRecord.output,
                  model,
                });
              }
            } catch (error) {
              logger.warn(
                `Async tokenization has failed. Falling back to synchronous tokenization`,
                error,
              );
              if (tokenCount) {
                newInputCount = tokenCount({
                  text: observationRecord.input,
                  model,
                });
                newOutputCount = tokenCount({
                  text: observationRecord.output,
                  model,
                });
              }
            }

            // Tracing
            newInputCount
              ? span.setAttribute(
                  "langfuse.tokenization.input-count",
                  newInputCount,
                )
              : undefined;
            newOutputCount
              ? span.setAttribute(
                  "langfuse.tokenization.output-count",
                  newOutputCount,
                )
              : undefined;
            newInputCount || newOutputCount
              ? span.setAttribute(
                  "langfuse.tokenization.tokenizer",
                  model.tokenizerId || "unknown",
                )
              : undefined;
            newInputCount
              ? recordIncrement("langfuse.tokenisedTokens", newInputCount)
              : undefined;
            newOutputCount
              ? recordIncrement("langfuse.tokenisedTokens", newOutputCount)
              : undefined;
          },
        );

        logger.debug(
          `Tokenized observation ${observationRecord.id} with model ${model.id}, input: ${newInputCount}, output: ${newOutputCount}`,
        );

        const newTotalCount =
          newInputCount || newOutputCount
            ? (newInputCount ?? 0) + (newOutputCount ?? 0)
            : undefined;

        const usage_details: Record<string, number> = {};

        if (newInputCount != null) usage_details.input = newInputCount;
        if (newOutputCount != null) usage_details.output = newOutputCount;
        if (newTotalCount != null) usage_details.total = newTotalCount;

        return { usage_details, provided_usage_details: providedUsageDetails };
      } catch (error) {
        traceException(error);
        logger.error(
          `Tokenization failed for observation ${observationRecord.id} with model ${model.id}. Continuing without token counts.`,
          error,
        );
        // Continue without token counts - return empty usage_details
        return {
          usage_details: {},
          provided_usage_details: providedUsageDetails,
        };
      }
    }

    const usageDetails = { ...providedUsageDetails };
    if (Object.keys(usageDetails).length > 0 && !("total" in usageDetails)) {
      usageDetails.total = Object.values(providedUsageDetails).reduce(
        (acc, value) => acc + value,
        0,
      );
    }

    return {
      usage_details: usageDetails,
      provided_usage_details: providedUsageDetails,
    };
  }

  static calculateUsageCosts(
    modelPrices:
      | Array<{ usageType: string; price: Decimal }>
      | null
      | undefined,
    observationRecord: Pick<
      ObservationRecordInsertType,
      "provided_cost_details"
    >,
    usageUnits: UsageCostType,
  ): Pick<ObservationRecordInsertType, "cost_details" | "total_cost"> {
    const { provided_cost_details } = observationRecord;

    const providedCostKeys = Object.entries(provided_cost_details ?? {})
      .filter(([_, value]) => value != null)
      .map(([key]) => key);

    // If user has provided any cost point, do not calculate any other cost points
    if (providedCostKeys.length) {
      const cost_details = { ...provided_cost_details };
      const finalTotalCost =
        (provided_cost_details ?? {})["total"] ??
        // Use provided input and output cost if available, but only if no other cost points are provided
        (providedCostKeys.every((key) => ["input", "output"].includes(key))
          ? ((provided_cost_details ?? {})["input"] ?? 0) +
            ((provided_cost_details ?? {})["output"] ?? 0)
          : undefined);

      if (
        !Object.prototype.hasOwnProperty.call(cost_details, "total") &&
        finalTotalCost != null
      ) {
        cost_details.total = finalTotalCost;
      }

      return {
        cost_details,
        total_cost: finalTotalCost,
      };
    }

    const finalCostEntries: [string, number][] = [];

    for (const [key, units] of Object.entries(usageUnits)) {
      const price = modelPrices?.find((price) => price.usageType === key);

      if (units != null && price) {
        finalCostEntries.push([key, price.price.mul(units).toNumber()]);
      }
    }

    const finalCostDetails = Object.fromEntries(finalCostEntries);

    let finalTotalCost;
    if (
      Object.prototype.hasOwnProperty.call(finalCostDetails, "total") &&
      finalCostDetails.total != null
    ) {
      finalTotalCost = finalCostDetails.total;
    } else if (finalCostEntries.length > 0) {
      finalTotalCost = finalCostEntries.reduce(
        (acc, [_, cost]) => acc + cost,
        0,
      );

      finalCostDetails.total = finalTotalCost;
    }

    return {
      cost_details: finalCostDetails,
      total_cost: finalTotalCost,
    };
  }

  private async getDorisRecord(params: {
    projectId: string;
    entityId: string;
    table: TableName.Scores;
    additionalFilters: {
      whereCondition: string;
      params: Record<string, unknown>;
    };
  }): Promise<ScoreRecordInsertType | null> {
    if (!this.dorisClient) {
      logger.warn("Doris client not available, skipping read", {
        projectId: params.projectId,
        table: params.table,
      });
      return null;
    }

    recordIncrement("langfuse.ingestion.doris_read_for_update", 1, {
      skipped: "false",
      table: params.table,
    });

    const { projectId, entityId, table, additionalFilters } = params;

    return await instrumentAsync(
      { name: `get-doris-${table}` },
      async (span) => {
        span.setAttribute("projectId", projectId);

        // getDorisRecord only services scores. The MAP-column to_json wrap
        // that other code paths use elsewhere is unnecessary here because
        // the scores table has no MAP columns whose values contain nested
        // JSON (Doris's MySQL protocol mis-escapes quotes in that case).
        let dorisQuery = `
          SELECT *
          FROM ${table}
          WHERE project_id = {projectId: String}
          AND id = {entityId: String}
          ${additionalFilters.whereCondition}
          ORDER BY event_ts DESC
          LIMIT 1
        `;

        const queryResult = await this.dorisClient!.queryWithParams({
          query: dorisQuery,
          query_params: {
            projectId,
            entityId,
            ...additionalFilters.params,
          },
        });

        const result = await queryResult.json();

        if (result.length === 0) return null;

        // Preprocess Doris result to match schema expectations
        const rawRecord = result[0];
        const processedRecord = this.preprocessDorisRecord(rawRecord, table);

        return convertScoreReadToInsert(
          scoreRecordReadSchema.parse(processedRecord),
        );
      },
    );
  }

  /**
   * Smart JSON parsing helper that handles complex nested JSON strings
   * Optimized for malformed nested JSON like: "key":"{"nested":"value"}"
   * Successfully tested with user's 289-character complex nested JSON example
   */
  private safeJsonParse(
    jsonString: string,
    fieldName: string,
    table: TableName,
    fallbackValue: any = {},
  ): any {
    const trimmed = jsonString.trim();

    // Handle common null/empty cases
    if (!trimmed || trimmed === "null" || trimmed === "NULL") {
      return fallbackValue;
    }

    // Handle empty object/array cases
    if (trimmed === "{}" || trimmed === "[]") {
      return trimmed === "[]" ? [] : {};
    }

    // First, try direct JSON parsing
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      // If direct parsing fails, try to fix malformed nested JSON
      try {
        const fixed = this.fixMalformedNestedJson(trimmed);
        if (fixed !== trimmed) {
          logger.debug(
            `Fixed malformed JSON in field ${fieldName} for table ${table}`,
          );
          return JSON.parse(fixed);
        }
        // Regex didn't match — the malformation pattern is unknown
        logger.warn(`Failed to parse JSON field (unfixable)`, {
          originalError: e instanceof Error ? e.message : String(e),
          field: fieldName,
          table,
          rawValue:
            trimmed.substring(0, 100) + (trimmed.length > 100 ? "..." : ""),
          valueLength: trimmed.length,
        });
      } catch (fixError) {
        logger.warn(`Failed to parse JSON field (fix threw)`, {
          originalError: e instanceof Error ? e.message : String(e),
          fixError:
            fixError instanceof Error ? fixError.message : String(fixError),
          field: fieldName,
          table,
          rawValue:
            trimmed.substring(0, 100) + (trimmed.length > 100 ? "..." : ""),
          valueLength: trimmed.length,
        });
      }

      return fallbackValue;
    }
  }

  /**
   * Fix malformed nested JSON strings produced by Doris MAP serialization.
   *
   * Doris's MySQL protocol serialization of Map<String,String> columns does not
   * properly escape quotes inside TEXT values that contain nested JSON. This
   * produces patterns like "key":"[{"inner":"val"}]" where inner {, ", and }
   * are unescaped, making the string invalid JSON.
   *
   * Recursively applies regex fixes for object values ("key":"{...}") and array
   * values ("key":"[{...}]") until the string stabilizes (no more unescaped
   * nested JSON patterns remain).
   */
  private fixMalformedNestedJson(str: string): string {
    const objectPattern = /"([^"]+)":"(\{(?:[^{}]*(?:\{[^{}]*\}[^{}]*)*)*\})"/g;
    const arrayPattern =
      /"([^"]+)":"(\[(?:[^\][]*(?:\[[^\][]*\][^\][]*)*)*\])"/g;

    let fixed = str;

    // Pass 1: escape unescaped quotes inside object values
    fixed = fixed.replace(objectPattern, (_match, key, jsonContent) => {
      const escapedContent = jsonContent.replace(/(?<!\\)"/g, '\\"');
      return `"${key}":"${escapedContent}"`;
    });

    // Pass 2: escape unescaped quotes inside array values
    fixed = fixed.replace(arrayPattern, (_match, key, jsonContent) => {
      const escapedContent = jsonContent.replace(/(?<!\\)"/g, '\\"');
      return `"${key}":"${escapedContent}"`;
    });

    // Remove trailing commas
    fixed = fixed.replace(/,(\s*[}\]])/g, "$1");

    // Recurse if changes were made (deeper nesting may now be exposed)
    return fixed !== str ? this.fixMalformedNestedJson(fixed) : fixed;
  }

  /**
   * Generic helper to parse JSON string fields into Record<string, string>
   * Used for metadata and similar fields requiring z.record(z.string())
   */
  private parseRecordField(
    fieldValue: any,
    fieldName: string,
    table: TableName,
    fallbackValue: Record<string, string> = {},
  ): Record<string, string> {
    if (!fieldValue) return fallbackValue;

    if (typeof fieldValue === "string") {
      const parsed = this.safeJsonParse(
        fieldValue,
        fieldName,
        table,
        fallbackValue,
      );
      if (typeof parsed === "object" && !Array.isArray(parsed)) {
        // Ensure all values are strings
        const result: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          result[key] = String(value);
        }
        return result;
      }
      // If parsing failed or result is not an object, use fallback value
      return fallbackValue;
    }

    if (typeof fieldValue === "object") {
      // Ensure all values are strings
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(fieldValue)) {
        result[key] = String(value);
      }
      return result;
    }

    return fallbackValue;
  }

  /**
   * Generic helper to parse JSON string fields into UsageCostSchema format
   * UsageCostSchema expects Record<string, string | null> that can be converted to numbers
   * Used for usage/cost details fields (provided_usage_details, usage_details, etc.)
   */
  private parseUsageCostField(
    fieldValue: any,
    fieldName: string,
    table: TableName,
    fallbackValue: Record<string, string | null> = {},
  ): Record<string, string | null> {
    if (!fieldValue) return fallbackValue;

    if (typeof fieldValue === "string") {
      const parsed = this.safeJsonParse(
        fieldValue,
        fieldName,
        table,
        fallbackValue,
      );
      if (typeof parsed === "object" && !Array.isArray(parsed)) {
        // Convert values to strings that can be parsed as numbers, or null
        const result: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (value === null || value === undefined) {
            result[key] = null;
          } else {
            // Convert to string, but ensure it's a valid number string
            const numValue = Number(value);
            result[key] = isNaN(numValue) ? null : String(numValue);
          }
        }
        return result;
      }
      return fallbackValue;
    }

    if (typeof fieldValue === "object") {
      // Convert values to strings that can be parsed as numbers, or null
      const result: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(fieldValue)) {
        if (value === null || value === undefined) {
          result[key] = null;
        } else {
          // Convert to string, but ensure it's a valid number string
          const numValue = Number(value);
          result[key] = isNaN(numValue) ? null : String(numValue);
        }
      }
      return result;
    }

    return fallbackValue;
  }

  /**
   * Generic helper to parse JSON string fields into string arrays
   * Used for tags and similar array fields
   */
  private parseArrayField(
    fieldValue: any,
    fieldName: string,
    table: TableName,
    fallbackValue: string[] = [],
  ): string[] {
    if (!fieldValue) return fallbackValue;

    if (typeof fieldValue === "string") {
      const parsed = this.safeJsonParse(
        fieldValue,
        fieldName,
        table,
        fallbackValue,
      );
      if (Array.isArray(parsed)) {
        return parsed.map((item: any) => String(item));
      }
      return fallbackValue;
    }

    if (Array.isArray(fieldValue)) {
      return fieldValue.map((item: any) => String(item));
    }

    return fallbackValue;
  }

  /**
   * Preprocess Doris query result to match schema expectations
   * Based on the exact schema definitions in definitions.ts
   */
  private preprocessDorisRecord(record: any, table: TableName): any {
    if (!record) return record;

    const processed = { ...record };

    // 1. Date fields: Convert Date objects to Doris format for dorisStringDateSchema
    // dorisStringDateSchema expects: '2024-05-23 18:33:41.602000'
    const dateFields = [
      "created_at",
      "updated_at",
      "event_ts",
      "timestamp",
      "start_time",
      "end_time",
      "completion_start_time",
    ];

    for (const field of dateFields) {
      if (processed[field] instanceof Date) {
        // Convert Date to Doris format: '2024-05-23 18:33:41.602000'
        const isoString = processed[field].toISOString();
        processed[field] = isoString.replace("T", " ").replace("Z", "");

        // Ensure microsecond precision (6 digits) as expected by Doris
        if (!processed[field].includes(".")) {
          processed[field] += ".000000";
        } else {
          const parts = processed[field].split(".");
          const microseconds = parts[1].padEnd(6, "0").substring(0, 6);
          processed[field] = parts[0] + "." + microseconds;
        }
      }
    }

    // 2. Metadata field: Convert JSON string to Record<string, string>
    processed.metadata = this.parseRecordField(
      processed.metadata,
      "metadata",
      table,
      {},
    );

    // 5. Boolean fields: Ensure they are booleans
    const booleanFields = ["public", "bookmarked"];
    for (const field of booleanFields) {
      if (processed[field] !== undefined) {
        if (typeof processed[field] === "string") {
          processed[field] =
            processed[field].toLowerCase() === "true" ||
            processed[field] === "1";
        } else if (typeof processed[field] === "number") {
          processed[field] = processed[field] !== 0;
        } else {
          processed[field] = Boolean(processed[field]);
        }
      }
    }

    // 6. Number fields: Ensure they are numbers
    const numberFields = ["is_deleted", "total_cost", "prompt_version"];
    for (const field of numberFields) {
      if (processed[field] !== undefined && processed[field] !== null) {
        if (typeof processed[field] === "string") {
          const parsed = Number(processed[field]);
          processed[field] = isNaN(parsed) ? null : parsed;
        }
      }
    }

    return processed;
  }

  /**
   * Get existing record from Doris backend
   */
  private async getAnalyticsRecord(params: {
    projectId: string;
    entityId: string;
    table: TableName.Scores;
    additionalFilters: {
      whereCondition: string;
      params: Record<string, unknown>;
    };
  }): Promise<ScoreRecordInsertType | null> {
    return await this.getDorisRecord(params as any);
  }

  private mapTraceEventsToRecords(params: {
    traceEventList: TraceEventType[];
    projectId: string;
    entityId: string;
  }) {
    const { traceEventList, projectId, entityId } = params;

    return traceEventList.map((trace) => {
      const traceRecord: TraceRecordInsertType = {
        id: entityId,
        timestamp: this.getMillisecondTimestamp(
          trace.body.timestamp ?? trace.timestamp,
        ),
        // timestamp: ("timestamp" in trace.body && trace.body.timestamp
        //   ? this.getMillisecondTimestamp(trace.body.timestamp)
        //   : undefined) as number, // Casting here is dirty, but our requirement is to have a start_time _after_ the merge
        name: trace.body.name,
        user_id: trace.body.userId,
        metadata: trace.body.metadata
          ? convertJsonSchemaToRecord(trace.body.metadata)
          : {},
        release: trace.body.release,
        version: trace.body.version,
        project_id: projectId,
        environment: trace.body.environment,
        public: trace.body.public ?? false,
        bookmarked: false,
        tags: trace.body.tags ?? [],
        // We skip the processing here as stringifying is an expensive operation on large objects.
        // Instead, we only take the last truthy value and apply it on the merge step.
        // input: this.stringify(trace.body.input),
        // output: this.stringify(trace.body.output), // convert even json to string
        session_id: trace.body.sessionId,
        created_at: Date.now(),
        updated_at: Date.now(),
        event_ts: new Date(trace.timestamp).getTime(),
        is_deleted: 0,
      };

      return traceRecord;
    });
  }

  private getObservationType(
    observation: ObservationEvent,
  ):
    | "EVENT"
    | "SPAN"
    | "GENERATION"
    | "AGENT"
    | "TOOL"
    | "CHAIN"
    | "RETRIEVER"
    | "EVALUATOR"
    | "GUARDRAIL"
    | "EMBEDDING" {
    switch (observation.type) {
      case eventTypes.OBSERVATION_CREATE:
      case eventTypes.OBSERVATION_UPDATE:
        return observation.body.type;
      case eventTypes.EVENT_CREATE:
        return "EVENT" as const;
      case eventTypes.SPAN_CREATE:
      case eventTypes.SPAN_UPDATE:
        return "SPAN" as const;
      case eventTypes.GENERATION_CREATE:
      case eventTypes.GENERATION_UPDATE:
        return "GENERATION" as const;
      case eventTypes.AGENT_CREATE:
        return "AGENT" as const;
      case eventTypes.TOOL_CREATE:
        return "TOOL" as const;
      case eventTypes.CHAIN_CREATE:
        return "CHAIN" as const;
      case eventTypes.RETRIEVER_CREATE:
        return "RETRIEVER" as const;
      case eventTypes.EVALUATOR_CREATE:
        return "EVALUATOR" as const;
      case eventTypes.EMBEDDING_CREATE:
        return "EMBEDDING" as const;
      case eventTypes.GUARDRAIL_CREATE:
        return "GUARDRAIL" as const;
    }
  }

  private mapObservationEventsToRecords(params: {
    projectId: string;
    entityId: string;
    observationEventList: ObservationEvent[];
    prompt: ObservationPrompt | null;
  }) {
    const { projectId, entityId, observationEventList, prompt } = params;

    return observationEventList.map((obs) => {
      const observationType = this.getObservationType(obs);

      const newInputCount =
        "usage" in obs.body ? obs.body.usage?.input : undefined;

      const newOutputCount =
        "usage" in obs.body ? obs.body.usage?.output : undefined;

      const newTotalCount =
        ("usage" in obs.body ? obs.body.usage?.total : undefined) ||
        (Object.keys(
          "usageDetails" in obs.body ? (obs.body.usageDetails ?? {}) : {},
        ).length === 0
          ? newInputCount && newOutputCount
            ? newInputCount + newOutputCount
            : (newInputCount ?? newOutputCount)
          : undefined);

      let provided_usage_details: Record<string, number> = {};

      if (newInputCount != null) provided_usage_details.input = newInputCount;
      if (newOutputCount != null)
        provided_usage_details.output = newOutputCount;
      if (newTotalCount != null) provided_usage_details.total = newTotalCount;

      provided_usage_details = {
        ...provided_usage_details,
        ...("usageDetails" in obs.body
          ? (Object.fromEntries(
              Object.entries(obs.body.usageDetails ?? {}).filter(
                ([_, val]) => val != null,
              ),
            ) as Record<string, number>)
          : {}),
      };

      let provided_cost_details: Record<string, number> = {};

      if ("usage" in obs.body) {
        const { inputCost, outputCost, totalCost } = obs.body.usage ?? {};

        if (inputCost != null) provided_cost_details.input = inputCost;
        if (outputCost != null) provided_cost_details.output = outputCost;
        if (totalCost != null) provided_cost_details.total = totalCost;
      }

      provided_cost_details = {
        ...provided_cost_details,
        ...("costDetails" in obs.body
          ? (Object.fromEntries(
              Object.entries(obs.body.costDetails ?? {}).filter(
                ([_, val]) => val != null,
              ),
            ) as Record<string, number>)
          : {}),
      };

      const observationRecord: ObservationRecordInsertType = {
        id: entityId,
        trace_id: obs.body.traceId ?? v4(),
        type: observationType,
        name: obs.body.name,
        environment:
          "environment" in obs.body ? obs.body.environment : "default",
        start_time: this.getMillisecondTimestamp(
          obs.body.startTime ?? obs.timestamp,
        ),
        // start_time: ("startTime" in obs.body && obs.body.startTime
        //   ? this.getMillisecondTimestamp(obs.body.startTime)
        //   : undefined) as number, // Casting here is dirty, but our requirement is to have a start_time _after_ the merge
        end_time:
          "endTime" in obs.body && obs.body.endTime
            ? this.getMillisecondTimestamp(obs.body.endTime)
            : undefined,
        completion_start_time:
          "completionStartTime" in obs.body && obs.body.completionStartTime
            ? this.getMillisecondTimestamp(obs.body.completionStartTime)
            : undefined,
        metadata: obs.body.metadata
          ? convertJsonSchemaToRecord(obs.body.metadata)
          : {},
        provided_model_name: "model" in obs.body ? obs.body.model : undefined,
        model_parameters:
          "modelParameters" in obs.body
            ? obs.body.modelParameters
              ? JSON.stringify(obs.body.modelParameters)
              : undefined
            : undefined,
        // We skip the processing here as stringifying is an expensive operation on large objects.
        // Instead, we only take the last truthy value and apply it on the merge step.
        // input: this.stringify(obs.body.input),
        // output: this.stringify(obs.body.output),
        provided_usage_details,
        provided_cost_details,
        usage_details: provided_usage_details,
        cost_details: provided_cost_details,
        level: obs.body.level,
        status_message: obs.body.statusMessage ?? undefined,
        parent_observation_id: obs.body.parentObservationId ?? undefined,
        version: obs.body.version ?? undefined,
        project_id: projectId,
        prompt_id: prompt?.id,
        prompt_name: prompt?.name,
        prompt_version: prompt?.version,
        created_at: Date.now(),
        updated_at: Date.now(),
        event_ts: new Date(obs.timestamp).getTime(),
        is_deleted: 0,
      };

      return observationRecord;
    });
  }

  private stringify(obj: unknown): string | undefined {
    if (obj == null) return; // return undefined on undefined or null

    return typeof obj === "string" ? obj : JSON.stringify(obj);
  }

  private getMicrosecondTimestamp(timestamp?: string | null): number {
    return timestamp ? new Date(timestamp).getTime() * 1000 : Date.now() * 1000;
  }

  private getMillisecondTimestamp(timestamp?: string | null): number {
    return timestamp ? new Date(timestamp).getTime() : Date.now();
  }

  /**
   * Returns a partition-aware timestamp for staging table writes.
   * If the createdAtTimestamp is within the last 2 minutes, returns it as-is.
   * Otherwise, returns the current timestamp to prevent updates to old partitions.
   *
   * This implements the partition locking strategy where partitions are "locked"
   * 4 minutes after creation (2 min + 2 min buffer for writes).
   *
   * Going down from 3.5min to 2min here, as we see gaps in the data that may come from deletions.
   * This reduces that chance that updates are handled in the same batch, but should increase the chance
   * that data is processed correctly. Worst case is slightly more duplication in the events table
   * which should resolve automatically using the ReplacingMergeTree.
   */
  private getPartitionAwareTimestamp(createdAtTimestamp: Date): number {
    const now = Date.now();
    const createdAt = createdAtTimestamp.getTime();
    const ageInMs = now - createdAt;
    const twoMinutesInMs = 2 * 60 * 1000;

    // If the createdAtTimestamp is within the last 2 minutes, use it
    // Otherwise, use the current timestamp to avoid updating old partitions
    return ageInMs < twoMinutesInMs ? createdAt : now;
  }
}

type ObservationPrompt = Pick<Prompt, "id" | "name" | "version">;
