import { removeEmptyEnvVariables } from "@langfuse/shared";
import { z } from "zod/v4";

const EnvSchema = z.object({
  BUILD_ID: z.string().optional(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string(),
  HOSTNAME: z.string().default("0.0.0.0"),
  PORT: z.coerce
    .number() // ".env files convert numbers to strings, therefore we have to enforce them to be numbers"
    .positive()
    .max(65536, `options.port should be >= 0 and < 65536`)
    .default(3030),

  NEXTAUTH_URL: z.string().optional(),

  NEXT_PUBLIC_LITEFUSE_CLOUD_REGION: z
    .enum(["US", "EU", "STAGING", "DEV", "HIPAA", "JP"])
    .optional(),

  LITEFUSE_CACHE_AUTOMATIONS_ENABLED: z.enum(["true", "false"]).default("true"),
  LITEFUSE_CACHE_AUTOMATIONS_TTL_SECONDS: z.coerce.number().default(60),
  LITEFUSE_S3_BATCH_EXPORT_ENABLED: z.enum(["true", "false"]).default("false"),
  LITEFUSE_S3_BATCH_EXPORT_BUCKET: z.string().optional(),
  LITEFUSE_S3_BATCH_EXPORT_PREFIX: z.string().default(""),
  LITEFUSE_S3_BATCH_EXPORT_REGION: z.string().optional(),
  LITEFUSE_S3_BATCH_EXPORT_ENDPOINT: z.string().optional(),
  LITEFUSE_S3_BATCH_EXPORT_EXTERNAL_ENDPOINT: z.string().optional(),
  LITEFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID: z.string().optional(),
  LITEFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY: z.string().optional(),
  LITEFUSE_S3_BATCH_EXPORT_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_S3_BATCH_EXPORT_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  LITEFUSE_S3_BATCH_EXPORT_SSE_KMS_KEY_ID: z.string().optional(),

  LITEFUSE_S3_EVENT_UPLOAD_BUCKET: z.string({
    error: "Langfuse requires a bucket name for S3 Event Uploads.",
  }),
  LITEFUSE_S3_EVENT_UPLOAD_PREFIX: z.string().default(""),
  LITEFUSE_S3_EVENT_UPLOAD_REGION: z.string().optional(),
  LITEFUSE_S3_EVENT_UPLOAD_ENDPOINT: z.string().optional(),
  LITEFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID: z.string().optional(),
  LITEFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: z.string().optional(),
  LITEFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_S3_EVENT_UPLOAD_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  LITEFUSE_S3_EVENT_UPLOAD_SSE_KMS_KEY_ID: z.string().optional(),

  BATCH_EXPORT_PAGE_SIZE: z.coerce.number().positive().default(500),
  BATCH_EXPORT_ROW_LIMIT: z.coerce.number().positive().default(1_500_000),
  BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS: z.coerce
    .number()
    .positive()
    .default(24),
  BATCH_EXPORT_S3_PART_SIZE_MIB: z.coerce.number().min(5).max(100).default(10),
  BATCH_ACTION_EXPORT_ROW_LIMIT: z.coerce.number().positive().default(50_000),
  LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT: z.coerce
    .number()
    .positive()
    .default(50_000),
  EMAIL_FROM_ADDRESS: z.string().optional(),
  SMTP_CONNECTION_URL: z.string().optional(),
  CLOUD_CRM_EMAIL: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  LITEFUSE_OTEL_INGESTION_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  // Otel grouper (exactly-once pipeline). Group sizing is a
  // production tuning knob: target SOURCE bytes must leave
  // headroom under BE streaming_load_json_max_mb after the transform
  // inflation ratio (measured in load tests).
  LITEFUSE_OTEL_GROUP_TARGET_BYTES: z.coerce
    .number()
    .positive()
    .default(64 * 1024 * 1024),
  LITEFUSE_OTEL_GROUP_TARGET_ROWS: z.coerce
    .number()
    .positive()
    .default(100_000),
  LITEFUSE_OTEL_GROUP_MAX_FILES: z.coerce.number().positive().default(1_000),
  // Flush timeout: a below-target group ships once its oldest entry waited
  // this long — bounds ingest latency at low traffic.
  LITEFUSE_OTEL_GROUP_FLUSH_MS: z.coerce.number().positive().default(1_000),
  LITEFUSE_OTEL_GROUPER_LOCK_TTL_MS: z.coerce
    .number()
    .positive()
    .default(10_000),
  // Lane-domain lease TTL (Stage 1.4): the single leader for all
  // project lanes. Kept SHORTER than the per-shard lock so a stalled leader is
  // taken over fast (≤ this) — data waits in pending, only cut latency spikes.
  LITEFUSE_OTEL_LANE_DOMAIN_LEASE_TTL_MS: z.coerce
    .number()
    .positive()
    .default(5_000),
  LITEFUSE_OTEL_GROUPER_TICK_MS: z.coerce.number().positive().default(200),
  // loop-cut fairness bounds (design: round-robin, not drain-one-lane). Per
  // tick the single leader cuts one group from each ripe lane per round, up to
  // MAX_CUTS_PER_LANE_PER_TICK rounds, capped at MAX_CUTS_PER_TICK total. A hot
  // single-project lane gets K× the old one-per-tick throughput; co-tenant
  // lanes still get a cut every round, so none starves. The total cap bounds
  // the leader's tick when many lanes are ripe at once.
  //
  // K default 4: at ~5 ticks/s that is ~20 groups/s from a single hot lane —
  // comfortably above the ~3 groups/s a 40w/s target needs, while staying below
  // the consumer ceiling so cut production doesn't over-run what workers drain
  // (over-producing just migrates the backlog from the compact pending list
  // into heavier BullMQ job records). Raise it if the consumer pool grows.
  LITEFUSE_OTEL_GROUPER_MAX_CUTS_PER_LANE_PER_TICK: z.coerce
    .number()
    .positive()
    .default(4),
  LITEFUSE_OTEL_GROUPER_MAX_CUTS_PER_TICK: z.coerce
    .number()
    .positive()
    .default(64),
  // Self-contained group job: per-worker semaphores.
  // TRANSFORM bounds concurrent S3 download + JSON.parse (event-loop/heap
  // protection); LOAD bounds concurrent stream loads (global tablet-writer
  // fan-out = N workers × this value).
  LITEFUSE_OTEL_TRANSFORM_CONCURRENCY: z.coerce.number().positive().default(4),
  LITEFUSE_OTEL_LOAD_CONCURRENCY: z.coerce.number().positive().default(4),
  // DLQ redrive. LABEL_KEEP_MS must mirror the Doris FE's
  // label_keep_max_second (default 3 days): a job older than the label
  // retention window CANNOT be redriven — its dedup label has been purged,
  // a blind replay would double-load — it must go to the poison ledger /
  // reconciliation path instead (age guard).
  LITEFUSE_OTEL_LABEL_KEEP_MS: z.coerce
    .number()
    .positive()
    .default(3 * 24 * 60 * 60 * 1000),
  LITEFUSE_OTEL_DLQ_MAX_REDRIVES: z.coerce.number().positive().default(5),
  LITEFUSE_OTEL_DLQ_BATCH_LIMIT: z.coerce.number().positive().default(500),
  // PG completion-ledger retention. MUST stay ABOVE the reconcile re-inject
  // threshold (--older-than-hours, default 80h) or the backstop manufactures
  // duplicates: a completed file whose ledger row expired, but whose
  // registered key (4d TTL) is still alive, classifies as reinject and gets
  // re-ingested. Ideally >= the reconcile scan window (8d) so completed
  // files never even degrade into audit noise. Default 10 days.
  LITEFUSE_OTEL_LEDGER_RETENTION_DAYS: z.coerce.number().positive().default(10),
  LITEFUSE_INGESTION_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(20),
  LITEFUSE_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LITEFUSE_SECONDARY_INGESTION_QUEUE_ENABLED_PROJECT_IDS: z.string().optional(),

  LITEFUSE_USE_AZURE_BLOB: z.enum(["true", "false"]).default("false"),

  // Doris ingestion configuration
  LITEFUSE_INGESTION_DORIS_WRITE_BATCH_SIZE: z.coerce
    .number()
    .positive()
    .default(1000),
  // Per-table BUFFER cap (worker memory / backpressure): addToQueue blocks
  // while a table's buffered bytes (fresh + parked retries) are at this cap,
  // leaving the backlog in BullMQ/Redis. This bounds RAM, not request size —
  // the per-request bound is MAX_BATCH_SIZE_BYTES below. Keep this >= that
  // (else batches degrade to buffer-sized); for throughput aim at roughly
  // MAX_CONCURRENT_LOADS * typical batch bytes.
  LITEFUSE_INGESTION_DORIS_MAX_QUEUE_SIZE_BYTES: z.coerce
    .number()
    .positive()
    .default(90 * 1024 * 1024), // 90MB
  // Per-BATCH byte cap (request sizing): batch assembly stops at batchSize rows
  // OR this many bytes, whichever first (always >= 1 row), and buffered bytes
  // reaching it make the table flush-ready without waiting for the row count /
  // staleness. Keeps a single Stream Load body clear of the BE's
  // streaming_load_json_max_mb (100MB) hard limit — without it, batchSize big
  // rows can assemble a >100MB body that fails deterministically and, under
  // infinite retry, wedges the table forever.
  LITEFUSE_INGESTION_DORIS_MAX_BATCH_SIZE_BYTES: z.coerce
    .number()
    .positive()
    .default(64 * 1024 * 1024), // 64MB — 36% headroom under the BE's 100MB
  // Max concurrent in-flight Stream Loads across all tables. Each in-flight
  // load holds its (~tens of MB) batch in memory while insert() retries, so an
  // unbounded fan-out balloons worker RSS when Doris rejects/stalls writes.
  // Bounds in-flight memory to ~this * batch-bytes; excess rows stay queued and
  // apply backpressure (see MAX_QUEUE_SIZE_BYTES) instead of piling up.
  LITEFUSE_INGESTION_DORIS_MAX_CONCURRENT_LOADS: z.coerce
    .number()
    .positive()
    .default(4),
  LITEFUSE_INGESTION_DORIS_WRITE_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(1000),
  LITEFUSE_INGESTION_DORIS_GAUGE_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(10_000),
  // Exponential backoff for a failed batch's retries: a failed batch is parked
  // in DorisWriter's per-table retryBuffer with retryNotBefore = now +
  // min(BASE * 2^(attempts-1), MAX). Backoff is per-batch — fresh rows and
  // other batches keep flowing; the wait is a timestamp, never a held
  // concurrency slot. See DorisWriter.parkForRetry.
  LITEFUSE_INGESTION_DORIS_RETRY_BACKOFF_BASE_MS: z.coerce
    .number()
    .positive()
    .default(1000),
  LITEFUSE_INGESTION_DORIS_RETRY_BACKOFF_MAX_MS: z.coerce
    .number()
    .positive()
    .default(30_000),
  // Analytics backend selection
  LITEFUSE_ANALYTICS_BACKEND: z.enum(["doris"]).default("doris"),

  // Doris configuration
  LITEFUSE_EVAL_CREATOR_LIMITER_DURATION: z.coerce
    .number()
    .positive()
    .default(500),

  // Doris configuration
  DORIS_URL: z.string().optional(),
  DORIS_FE_HTTP_URL: z.string().url().optional(),
  DORIS_FE_QUERY_PORT: z.coerce.number().positive().default(9030).optional(),
  DORIS_DB: z.string().default("langfuse").optional(),
  DORIS_USER: z.string().optional(),
  DORIS_PASSWORD: z.string().optional(),
  LITEFUSE_AUTO_DORIS_MIGRATION_DISABLED: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_EVAL_CREATOR_WORKER_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(2),
  LITEFUSE_TRACE_UPSERT_WORKER_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(25),
  LITEFUSE_TRACE_DELETE_CONCURRENCY: z.coerce.number().positive().default(1),
  LITEFUSE_SCORE_DELETE_CONCURRENCY: z.coerce.number().positive().default(1),
  LITEFUSE_DATASET_DELETE_CONCURRENCY: z.coerce.number().positive().default(1),
  LITEFUSE_PROJECT_DELETE_CONCURRENCY: z.coerce.number().positive().default(1),
  LITEFUSE_EVAL_EXECUTION_WORKER_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LITEFUSE_EVAL_EXECUTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LITEFUSE_SECONDARY_EVAL_EXECUTION_QUEUE_ENABLED_PROJECT_IDS: z
    .string()
    .optional(),
  LITEFUSE_EXPERIMENT_CREATOR_WORKER_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),

  // Skip the read from Doris within the Ingestion pipeline for the given
  // project ids. Applicable for projects that were created after the S3 write
  // was activated and which don't rely on historic updates.
  LITEFUSE_SKIP_INGESTION_DORIS_READ_PROJECT_IDS: z.string().default(""),
  // Set a date after which S3 was active. Projects created after this date do
  // not perform a Doris read as part of the ingestion pipeline.
  LITEFUSE_SKIP_INGESTION_DORIS_READ_MIN_PROJECT_CREATE_DATE: z
    .string()
    .date()
    .optional(),

  // Otel
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318"),
  OTEL_SERVICE_NAME: z.string().default("worker"),

  LITEFUSE_ENABLE_BACKGROUND_MIGRATIONS: z
    .enum(["true", "false"])
    .default("true"),

  LITEFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE: z
    .enum(["true", "false"])
    .default("false"),

  // Off by default: per-file write on the ingestion hot path, only needed for
  // S3 retention/deletion reconciliation. When enabled it writes PG, not Doris.
  LITEFUSE_ENABLE_BLOB_STORAGE_FILE_LOG: z
    .enum(["true", "false"])
    .default("false"),

  // Comma-separated list of project IDs that should only export traces table (skip observations and scores)
  LITEFUSE_BLOB_STORAGE_EXPORT_TRACE_ONLY_PROJECT_IDS: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((id) => id.trim()) : [])),

  // Flags to toggle queue consumers on or off.
  QUEUE_CONSUMER_CLOUD_USAGE_METERING_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_CLOUD_SPEND_ALERT_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_FREE_TIER_USAGE_THRESHOLD_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_INGESTION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_DORIS_SPLIT_TABLE_PROVISIONING_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_BATCH_EXPORT_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_BATCH_ACTION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_EVAL_EXECUTION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_EVAL_EXECUTION_SECONDARY_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_TRACE_UPSERT_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_CREATE_EVAL_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_TRACE_DELETE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_SCORE_DELETE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_DATASET_DELETE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_PROJECT_DELETE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_DATASET_RUN_ITEM_UPSERT_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_EXPERIMENT_CREATE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_POSTHOG_INTEGRATION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_MIXPANEL_INTEGRATION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_BLOB_STORAGE_INTEGRATION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_OTEL_INGESTION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_INGESTION_SECONDARY_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_DATA_RETENTION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_DEAD_LETTER_RETRY_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  QUEUE_CONSUMER_WEBHOOK_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_ENTITY_CHANGE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_EVENT_PROPAGATION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  QUEUE_CONSUMER_NOTIFICATION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),

  LITEFUSE_EVENT_PROPAGATION_WORKER_GLOBAL_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(10),
  LITEFUSE_DATASET_RUN_BACKFILL_CHUNK_SIZE: z.coerce
    .number()
    .positive()
    .default(200),
  LITEFUSE_EXPERIMENT_BACKFILL_THROTTLE_MS: z.coerce
    .number()
    .positive()
    .default(5 * 60 * 1000), // 5 minutes

  // Core data S3 upload - Langfuse Cloud
  LITEFUSE_S3_CORE_DATA_EXPORT_IS_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_S3_CORE_DATA_UPLOAD_BUCKET: z.string().optional(),
  LITEFUSE_S3_CORE_DATA_UPLOAD_PREFIX: z.string().default(""),
  LITEFUSE_S3_CORE_DATA_UPLOAD_REGION: z.string().optional(),
  LITEFUSE_S3_CORE_DATA_UPLOAD_ENDPOINT: z.string().optional(),
  LITEFUSE_S3_CORE_DATA_UPLOAD_ACCESS_KEY_ID: z.string().optional(),
  LITEFUSE_S3_CORE_DATA_UPLOAD_SECRET_ACCESS_KEY: z.string().optional(),
  LITEFUSE_S3_CORE_DATA_UPLOAD_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_S3_CORE_DATA_UPLOAD_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  LITEFUSE_S3_CORE_DATA_UPLOAD_SSE_KMS_KEY_ID: z.string().optional(),

  // Media upload
  LITEFUSE_S3_MEDIA_UPLOAD_BUCKET: z.string().optional(),
  LITEFUSE_S3_MEDIA_UPLOAD_PREFIX: z.string().default(""),
  LITEFUSE_S3_MEDIA_UPLOAD_REGION: z.string().optional(),
  LITEFUSE_S3_MEDIA_UPLOAD_ENDPOINT: z.string().optional(),
  LITEFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID: z.string().optional(),
  LITEFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY: z.string().optional(),
  LITEFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_S3_MEDIA_UPLOAD_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  LITEFUSE_S3_MEDIA_UPLOAD_SSE_KMS_KEY_ID: z.string().optional(),

  // Metering data Postgres export - Langfuse Cloud
  LITEFUSE_POSTGRES_METERING_DATA_EXPORT_IS_ENABLED: z
    .enum(["true", "false"])
    .default("false"),

  // When disabled: Usage is still tracked in DB but no emails are sent and no orgs are blocked
  // When enabled: Full enforcement (emails + blocking)
  LITEFUSE_FREE_TIER_USAGE_THRESHOLD_ENFORCEMENT_ENABLED: z
    .enum(["true", "false"])
    .default("false"),

  LITEFUSE_S3_CONCURRENT_READS: z.coerce.number().positive().default(50),
  LITEFUSE_DORIS_PROJECT_DELETION_CONCURRENCY_DURATION_MS: z.coerce
    .number()
    .positive()
    .default(600_000), // 10 minutes
  LITEFUSE_DORIS_TRACE_DELETION_CONCURRENCY_DURATION_MS: z.coerce
    .number()
    .positive()
    .default(120_000), // 2 minutes
  LITEFUSE_DORIS_DATASET_DELETION_CONCURRENCY_DURATION_MS: z.coerce
    .number()
    .positive()
    .default(120_000), // 2 minutes

  // Batch Project Cleaner configuration
  LITEFUSE_BATCH_PROJECT_CLEANER_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_BATCH_PROJECT_CLEANER_CHECK_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(600_000), // 10 minutes between checks after successful processing
  LITEFUSE_BATCH_PROJECT_CLEANER_SLEEP_ON_EMPTY_MS: z.coerce
    .number()
    .positive()
    .default(3_600_000), // 1 hour sleep when there is no data to process
  LITEFUSE_BATCH_PROJECT_CLEANER_PROJECT_LIMIT: z.coerce
    .number()
    .positive()
    .default(1000), // Max projects per batch
  LITEFUSE_BATCH_PROJECT_CLEANER_DELETE_TIMEOUT_MS: z.coerce
    .number()
    .positive()
    .default(3_600_000), // 1 hour for DELETE operations

  // Batch Project Media Cleaner configuration (S3/PostgreSQL)
  LITEFUSE_BATCH_PROJECT_MEDIA_CLEANER_BATCH_SIZE: z.coerce
    .number()
    .positive()
    .default(5000), // Media items per chunk

  // Batch Data Retention Cleaner configuration (Doris)
  LITEFUSE_BATCH_DATA_RETENTION_CLEANER_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_BATCH_DATA_RETENTION_CLEANER_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(3_600_000), // 1 hour between runs
  LITEFUSE_MEDIA_RETENTION_CLEANER_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(600_000), // 10 minutes between runs
  LITEFUSE_BATCH_DATA_RETENTION_CLEANER_PROJECT_LIMIT: z.coerce
    .number()
    .positive()
    .default(100), // Max projects per batch DELETE
  LITEFUSE_BATCH_DATA_RETENTION_CLEANER_CHUNK_SIZE: z.coerce
    .number()
    .positive()
    .default(100), // Chunk size for counting projects in Doris
  LITEFUSE_BATCH_DATA_RETENTION_CLEANER_DELETE_TIMEOUT_MS: z.coerce
    .number()
    .positive()
    .default(3_600_000), // 1 hour for DELETE operations

  // Media Retention Cleaner configuration (S3/PostgreSQL)
  LITEFUSE_MEDIA_RETENTION_CLEANER_ITEM_LIMIT: z.coerce
    .number()
    .positive()
    .default(10_000), // Max items (media files) to process per batch

  // Batch Trace Deletion Cleaner configuration
  LITEFUSE_BATCH_TRACE_DELETION_CLEANER_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_BATCH_TRACE_DELETION_CLEANER_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(600_000), // 10 minutes between runs
  LITEFUSE_BATCH_TRACE_DELETION_CLEANER_LOCK_TTL_SECONDS: z.coerce
    .number()
    .positive()
    .default(7200), // 2 hours to handle worst-case deletions

  LITEFUSE_EXPERIMENT_BACKFILL_EXCLUDE_ATTRIBUTES_KEY: z
    .enum(["true", "false"])
    .default("false"),

  // Deprecated. Do not use!
  LITEFUSE_EXPERIMENT_RETURN_NEW_RESULT: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_EXPERIMENT_INSERT_INTO_EVENTS_TABLE: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_EXPERIMENT_EARLY_EXIT_EVENT_BATCH_JOB: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_EXPERIMENT_EVENT_PROPAGATION_PARTITION_DELAY_MINUTES: z.coerce
    .number()
    .positive()
    .int()
    .default(10),

  LITEFUSE_WEBHOOK_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LITEFUSE_WEBHOOK_TIMEOUT_MS: z.coerce.number().positive().default(10000),
  LITEFUSE_WEBHOOK_MAX_REDIRECTS: z.coerce.number().positive().default(10),
  LITEFUSE_ENTITY_CHANGE_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(2),
  LITEFUSE_DELETE_BATCH_SIZE: z.coerce.number().positive().default(2000),
  LITEFUSE_TOKEN_COUNT_WORKER_POOL_SIZE: z.coerce
    .number()
    .positive()
    .default(2),
});

export const env: z.infer<typeof EnvSchema> =
  process.env.DOCKER_BUILD === "1" // eslint-disable-line turbo/no-undeclared-env-vars
    ? (process.env as any)
    : EnvSchema.parse(removeEmptyEnvVariables(process.env));
