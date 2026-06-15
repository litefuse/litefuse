import { z } from "zod/v4";
import { removeEmptyEnvVariables } from "./utils/environment";

const EnvSchema = z.object({
  NEXT_PUBLIC_LITEFUSE_CLOUD_REGION: z.string().optional(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  NEXTAUTH_URL: z.string().url().optional(),
  EMAIL_FROM_ADDRESS: z.string().optional(),
  SMTP_CONNECTION_URL: z.string().optional(),
  CLOUD_CRM_EMAIL: z.string().optional(),
  REDIS_HOST: z.string().nullish(),
  REDIS_PORT: z.coerce
    .number() // .env files convert numbers to strings, therefore we have to enforce them to be numbers
    .positive()
    .max(65536, `options.port should be >= 0 and < 65536`)
    .default(6379)
    .nullable(),
  REDIS_AUTH: z.string().nullish(),
  REDIS_USERNAME: z.string().nullish(),
  REDIS_CONNECTION_STRING: z.string().nullish(),
  // Optional prefix for Redis keys. Used by BullMQ queues via their native prefix option
  // and by the singleton cache instance via ioredis keyPrefix. Useful for multi-tenant Redis.
  REDIS_KEY_PREFIX: z.string().nullish(),
  REDIS_TLS_ENABLED: z.enum(["true", "false"]).default("false"),
  REDIS_TLS_CA_PATH: z.string().optional(),
  REDIS_TLS_CERT_PATH: z.string().optional(),
  REDIS_TLS_KEY_PATH: z.string().optional(),
  REDIS_TLS_SERVERNAME: z.string().optional(),
  REDIS_TLS_REJECT_UNAUTHORIZED: z.enum(["true", "false"]).optional(),
  REDIS_TLS_CHECK_SERVER_IDENTITY: z.enum(["true", "false"]).optional(),
  REDIS_TLS_SECURE_PROTOCOL: z.string().optional(),
  REDIS_TLS_CIPHERS: z.string().optional(),
  REDIS_TLS_HONOR_CIPHER_ORDER: z.enum(["true", "false"]).optional(),
  REDIS_TLS_KEY_PASSPHRASE: z.string().optional(),
  REDIS_ENABLE_AUTO_PIPELINING: z.enum(["true", "false"]).default("true"),
  // Redis Cluster Configuration
  REDIS_CLUSTER_ENABLED: z.enum(["true", "false"]).default("false"),
  REDIS_CLUSTER_NODES: z.string().optional(),
  REDIS_CLUSTER_SLOTS_REFRESH_TIMEOUT: z.coerce
    .number()
    .int()
    .positive()
    .default(5000),
  REDIS_SENTINEL_ENABLED: z.enum(["true", "false"]).default("false"),
  REDIS_SENTINEL_NODES: z.string().optional(),
  REDIS_SENTINEL_MASTER_NAME: z.string().optional(),
  REDIS_SENTINEL_USERNAME: z.string().optional(),
  REDIS_SENTINEL_PASSWORD: z.string().optional(),
  ENCRYPTION_KEY: z
    .string()
    .length(
      64,
      "ENCRYPTION_KEY must be 256 bits, 64 string characters in hex format, generate via: openssl rand -hex 32",
    )
    .optional(),
  LITEFUSE_CACHE_MODEL_MATCH_ENABLED: z.enum(["true", "false"]).default("true"),
  LITEFUSE_CACHE_MODEL_MATCH_TTL_SECONDS: z.coerce.number().default(86400), // 24 hours
  LITEFUSE_CACHE_PROMPT_ENABLED: z.enum(["true", "false"]).default("true"),
  LITEFUSE_CACHE_PROMPT_TTL_SECONDS: z.coerce.number().default(3600), // 1h

  // Doris configuration
  DORIS_URL: z.string().url().optional(),
  DORIS_FE_HTTP_URL: z.string().url().default("http://localhost:8030"),
  DORIS_FE_QUERY_PORT: z.coerce.number().positive().default(9030),
  DORIS_DB: z.string().default("langfuse"),
  DORIS_USER: z.string().optional(),
  DORIS_PASSWORD: z.string().default(""),
  DORIS_MAX_OPEN_CONNECTIONS: z.coerce.number().int().default(25),
  DORIS_REQUEST_TIMEOUT_MS: z.coerce.number().default(30000),
  LITEFUSE_INGESTION_DORIS_MAX_ATTEMPTS: z.coerce
    .number()
    .positive()
    .default(1000),
  LITEFUSE_INGESTION_DORIS_HTTP_MAX_SOCKETS: z.coerce
    .number()
    .positive()
    .default(200),
  LITEFUSE_DORIS_LOG_STREAM_LOAD_RESPONSE: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_DORIS_LOG_QUERIES: z.enum(["true", "false"]).default("false"),
  LITEFUSE_DORIS_SLOW_QUERY_THRESHOLD_MS: z.coerce
    .number()
    .positive()
    .default(2000),
  LITEFUSE_AUTO_DORIS_MIGRATION_DISABLED: z
    .enum(["true", "false"])
    .default("false"),

  // Analytics backend selection (Doris only)
  LITEFUSE_ANALYTICS_BACKEND: z.enum(["doris"]).default("doris"),

  LITEFUSE_INGESTION_QUEUE_DELAY_MS: z.coerce
    .number()
    .nonnegative()
    .default(15_000),
  LITEFUSE_INGESTION_QUEUE_SHARD_COUNT: z.coerce.number().positive().default(1),
  LITEFUSE_OTEL_INGESTION_QUEUE_SHARD_COUNT: z.coerce
    .number()
    .positive()
    .default(1),
  LITEFUSE_TRACE_UPSERT_QUEUE_SHARD_COUNT: z.coerce
    .number()
    .positive()
    .default(1),
  LITEFUSE_TRACE_UPSERT_QUEUE_ATTEMPTS: z.coerce.number().positive().default(2),
  LITEFUSE_TRACE_DELETE_DELAY_MS: z.coerce
    .number()
    .nonnegative()
    .default(5_000),
  LITEFUSE_TRACE_DELETE_SKIP_PROJECT_IDS: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((id) => id.trim()) : [])),
  SALT: z.string().optional(), // used by components imported by web package
  LITEFUSE_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .optional(),
  LITEFUSE_LOG_FORMAT: z.enum(["text", "json"]).default("text"),
  LITEFUSE_LOG_PROPAGATED_HEADERS: z
    .string()
    .optional()
    .transform((s) =>
      s ? s.split(",").map((s) => s.toLowerCase().trim()) : [],
    ),
  ENABLE_AWS_CLOUDWATCH_METRIC_PUBLISHING: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_S3_CONCURRENT_WRITES: z.coerce.number().positive().default(1000),
  LITEFUSE_S3_UPLOAD_ENABLE_BUFFERED: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_S3_UPLOAD_MAX_PART_ATTEMPTS: z.coerce
    .number()
    .min(1)
    .max(10)
    .default(3),
  LITEFUSE_S3_UPLOAD_MAX_CONCURRENT_PARTS: z.coerce
    .number()
    .min(1)
    .max(10)
    .default(3),
  LITEFUSE_S3_EVENT_UPLOAD_BUCKET: z.string().optional(), // Optional for Doris-only deployments
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
  LITEFUSE_USE_AZURE_BLOB: z.enum(["true", "false"]).default("false"),
  LITEFUSE_AZURE_SKIP_CONTAINER_CHECK: z
    .enum(["true", "false"])
    .default("true"),
  LITEFUSE_USE_GOOGLE_CLOUD_STORAGE: z.enum(["true", "false"]).default("false"),
  LITEFUSE_GOOGLE_CLOUD_STORAGE_CREDENTIALS: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),

  LITEFUSE_ENABLE_BLOB_STORAGE_FILE_LOG: z
    .enum(["true", "false"])
    .default("true"),

  LITEFUSE_S3_LIST_MAX_KEYS: z.coerce.number().positive().default(200),
  LITEFUSE_S3_RATE_ERROR_SLOWDOWN_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_S3_RATE_ERROR_SLOWDOWN_TTL_SECONDS: z.coerce
    .number()
    .positive()
    .default(3600), // 1 hour
  LITEFUSE_S3_CORE_DATA_EXPORT_IS_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_S3_CORE_DATA_EXPORT_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  LITEFUSE_S3_CORE_DATA_EXPORT_SSE_KMS_KEY_ID: z.string().optional(),
  LITEFUSE_POSTGRES_METERING_DATA_EXPORT_IS_ENABLED: z
    .enum(["true", "false"])
    .default("false"),

  LITEFUSE_CUSTOM_SSO_EMAIL_CLAIM: z.string().default("email"),
  LITEFUSE_CUSTOM_SSO_NAME_CLAIM: z.string().default("name"),
  LITEFUSE_CUSTOM_SSO_SUB_CLAIM: z.string().default("sub"),
  LITEFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES: z.coerce
    .number()
    .default(80e6), // 80MB
  LITEFUSE_DORIS_DELETION_TIMEOUT_MS: z.coerce.number().default(600_000), // 10 minutes
  LITEFUSE_DORIS_QUERY_MAX_ATTEMPTS: z.coerce.number().default(3), // Maximum attempts for socket hang up errors
  LITEFUSE_SKIP_S3_LIST_FOR_OBSERVATIONS_PROJECT_IDS: z.string().optional(),
  LITEFUSE_INGESTION_PROCESSING_SAMPLED_PROJECTS: z
    .string()
    .optional()
    .transform((val) => {
      try {
        if (!val) return new Map<string, number>();

        const map = new Map<string, number>();
        const parts = val.split(",");

        for (const part of parts) {
          const [projectId, sampleRateStr] = part.split(":");

          if (!projectId || sampleRateStr === undefined) {
            throw new Error(`Invalid format: ${part}`);
          }

          // Validate sample rate is between 0 and 1
          const sampleRate = z.coerce
            .number()
            .min(0)
            .max(1)
            .parse(sampleRateStr);

          map.set(projectId, sampleRate);
        }

        return map;
      } catch {
        return new Map<string, number>();
      }
    }),
  LITEFUSE_WEBHOOK_WHITELISTED_IPS: z
    .string()
    .optional()
    .transform((s) =>
      s ? s.split(",").map((s) => s.toLowerCase().trim()) : [],
    ),
  LITEFUSE_WEBHOOK_WHITELISTED_IP_SEGMENTS: z
    .string()
    .optional()
    .transform((s) =>
      s ? s.split(",").map((s) => s.toLowerCase().trim()) : [],
    ),
  LITEFUSE_WEBHOOK_WHITELISTED_HOST: z
    .string()
    .optional()
    .transform((s) =>
      s ? s.split(",").map((s) => s.toLowerCase().trim()) : [],
    ),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_STATE_SECRET: z.string().optional(),
  SLACK_FETCH_LIMIT: z.coerce
    .number()
    .positive()
    .optional()
    .default(5_000)
    .describe(
      "How many records should be fetched from Slack, before we give up",
    ),
  HTTPS_PROXY: z.string().optional(),

  LITEFUSE_SERVER_SIDE_IO_CHAR_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(1_000),

  LITEFUSE_DORIS_DATA_EXPORT_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(600_000), // 10 minutes

  LITEFUSE_EVENT_PROPAGATION_WORKER_GLOBAL_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(10),

  LITEFUSE_FETCH_LLM_COMPLETION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000), // 2 minutes

  LITEFUSE_AWS_BEDROCK_REGION: z.string().optional(),

  // API Performance Flags
  // Enable Redis-based tracking of projects using OTEL API to optimize queries.
  // When enabled, projects ingesting via OTEL API skip certain modifiers for better performance.
  LITEFUSE_SKIP_FINAL_FOR_OTEL_PROJECTS: z
    .enum(["true", "false"])
    .default("false"),

  // Langfuse AI Features
  LITEFUSE_AI_FEATURES_PUBLIC_KEY: z.string().optional(),
  LITEFUSE_AI_FEATURES_SECRET_KEY: z.string().optional(),
  LITEFUSE_AI_FEATURES_HOST: z.string().optional(),
  LITEFUSE_AI_FEATURES_PROJECT_ID: z.string().optional(),

  // Dataset Service
  LITEFUSE_DATASET_SERVICE_WRITE_TO_VERSIONED_IMPLEMENTATION: z
    .enum(["true", "false"])
    .default("true"),
  LITEFUSE_DATASET_SERVICE_READ_FROM_VERSIONED_IMPLEMENTATION: z
    .enum(["true", "false"])
    .default("true"),

  // Legacy events table (transitional deployment)
  LITEFUSE_LEGACY_EVENTS_TABLE_EXISTS: z
    .enum(["true", "false"])
    .default("true"),

  // Ingestion Masking (EE feature)
  LITEFUSE_INGESTION_MASKING_CALLBACK_URL: z.string().url().optional(),
  LITEFUSE_INGESTION_MASKING_CALLBACK_TIMEOUT_MS: z.coerce
    .number()
    .positive()
    .default(500),
  LITEFUSE_INGESTION_MASKING_CALLBACK_FAIL_CLOSED: z
    .enum(["true", "false"])
    .default("false"),
  LITEFUSE_INGESTION_MASKING_MAX_RETRIES: z.coerce
    .number()
    .nonnegative()
    .default(1),
  LITEFUSE_INGESTION_MASKING_PROPAGATED_HEADERS: z
    .string()
    .optional()
    .transform((s) =>
      s ? s.split(",").map((h) => h.toLowerCase().trim()) : [],
    ),
});

export type SharedEnv = z.infer<typeof EnvSchema>;

export const env: SharedEnv =
  process.env.DOCKER_BUILD === "1" // eslint-disable-line turbo/no-undeclared-env-vars
    ? (process.env as any)
    : EnvSchema.parse(removeEmptyEnvVariables(process.env));
