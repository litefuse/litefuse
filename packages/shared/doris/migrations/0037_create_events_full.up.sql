-- events_full: unified single table replacing traces + observations.
-- Aligned with langfuse V4 main schema. Each row is a "span" (OTel terminology):
--   * synthetic trace spans use span_id = 't-' || trace_id and parent_span_id = ''
--   * observation spans use the SDK-provided id and may reference parent_observation_id
--
-- Storage model: Unique Key + Merge-on-Write.
--   Cross-batch correctness is owned by IngestionService: full-row
--   pre-read + per-column merge before each Stream Load. Doris MoW
--   resolves any remaining conflicts by load order; that's enough given
--   the writer always sends the post-merge state. (V3 traces /
--   observation_source used the same pattern without a sequence_col
--   binding and were correct.)
--
-- All non-key columns are nullable or have DEFAULT so that Stream Load with
-- `partial_update_new_key_behavior=APPEND` can insert new rows from arbitrary
-- partial event payloads.

CREATE TABLE if not exists events_full (
    -- Key identifiers
    `project_id` varchar(64) NOT NULL,
    `start_time_date` Date NOT NULL,
    `span_id` varchar(64) NOT NULL,

    -- Span relationships
    `trace_id` varchar(64),
    `parent_span_id` String,

    -- Timestamps
    `start_time` DateTime(3),
    `end_time` DateTime(3),
    `completion_start_time` DateTime(3),

    -- Core span properties
    `name` String,
    `type` varchar(64),
    `environment` String DEFAULT 'default',
    `version` String,
    `release` String,
    `level` String,
    `status_message` String,

    -- Trace-level updatable properties (only meaningful on synthetic trace spans
    -- but kept on every row for column-locality at query time)
    `trace_name` String,
    `user_id` String,
    `session_id` String,
    `tags` ARRAY<String>,
    `bookmarked` Boolean DEFAULT 'false',
    `public` Boolean DEFAULT 'false',

    -- Prompt linkage
    `prompt_id` String,
    `prompt_name` String,
    `prompt_version` int,

    -- Model
    `model_id` String,
    `provided_model_name` String,
    `model_parameters` String,

    -- Usage & Cost (Map types; pricing tier columns added in 0031)
    `provided_usage_details` Map<String, BIGINT>,
    `usage_details` Map<String, BIGINT>,
    `provided_cost_details` Map<String, Decimal(38, 12)>,
    `cost_details` Map<String, Decimal(38, 12)>,
    `total_cost` Decimal(38, 12),
    `usage_pricing_tier_id` String,
    `usage_pricing_tier_name` String,

    -- Tools
    `tool_definitions` Map<String, String>,
    `tool_calls` ARRAY<String>,
    `tool_call_names` ARRAY<String>,

    -- I/O (Variant: stores arbitrary JSON; queries can use variant_col['path']).
    `input` Variant,
    `output` Variant,

    -- Flattened metadata (parallel arrays, matches main V4 events_full).
    -- Cross-batch deep-merge happens in IngestionService.mergeFlatMetadata
    -- on top of the full-row pre-read (set-union by key, new wins on conflict).
    `metadata_names` ARRAY<String>,
    `metadata_values` ARRAY<String>,

    -- Experiment fields (populated by an async backfill job from dataset_run_items_rmt)
    `experiment_id` String,
    `experiment_name` String,
    `experiment_metadata_names` ARRAY<String>,
    `experiment_metadata_values` ARRAY<String>,
    `experiment_description` String,
    `experiment_dataset_id` String,
    `experiment_item_id` String,
    `experiment_item_version` DateTime(3),
    `experiment_item_expected_output` String,
    `experiment_item_metadata_names` ARRAY<String>,
    `experiment_item_metadata_values` ARRAY<String>,
    `experiment_item_root_span_id` String,

    -- Source / instrumentation (OTel-derived)
    `source` String,
    `service_name` String,
    `service_version` String,
    `scope_name` String,
    `scope_version` String,
    `telemetry_sdk_language` String,
    `telemetry_sdk_name` String,
    `telemetry_sdk_version` String,

    -- Storage / housekeeping
    `blob_storage_file_path` String,
    `event_bytes` BIGINT,

    `created_at` DateTime(3) DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DateTime(3) DEFAULT CURRENT_TIMESTAMP(3),
    `event_ts` DateTime(3) NOT NULL,
    `is_deleted` int DEFAULT '0',

    INDEX idx_span_id (`span_id`) USING INVERTED COMMENT 'inverted index for span_id',
    INDEX idx_trace_id (`trace_id`) USING INVERTED COMMENT 'inverted index for trace_id',
    INDEX idx_parent_span_id (`parent_span_id`) USING INVERTED COMMENT 'inverted index for parent_span_id',
    INDEX idx_project_id (`project_id`) USING INVERTED COMMENT 'inverted index for project_id',
    INDEX idx_user_id (`user_id`) USING INVERTED COMMENT 'inverted index for user_id',
    INDEX idx_session_id (`session_id`) USING INVERTED COMMENT 'inverted index for session_id',
    INDEX idx_tags (`tags`) USING INVERTED COMMENT 'inverted index for tags',
    INDEX idx_type (`type`) USING INVERTED COMMENT 'inverted index for type',
    INDEX idx_environment (`environment`) USING INVERTED COMMENT 'inverted index for environment',
    INDEX idx_prompt_name (`prompt_name`) USING INVERTED COMMENT 'inverted index for prompt_name',
    INDEX idx_provided_model_name (`provided_model_name`) USING INVERTED COMMENT 'inverted index for provided_model_name',
    INDEX idx_source (`source`) USING INVERTED COMMENT 'inverted index for source (otel/ingestion-api-dual-write)'
) ENGINE=OLAP
UNIQUE KEY(`project_id`, `start_time_date`, `span_id`)
AUTO PARTITION BY RANGE (date_trunc(`start_time_date`, 'day')) ()
DISTRIBUTED BY HASH(`project_id`) BUCKETS 8
PROPERTIES (
    "replication_allocation" = "tag.location.default: 1",
    "enable_unique_key_merge_on_write" = "true"
);
