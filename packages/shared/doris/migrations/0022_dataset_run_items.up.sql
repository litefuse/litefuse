CREATE TABLE IF NOT EXISTS dataset_run_items_rmt (
    `project_id` varchar(64) NOT NULL,
    `dataset_id` varchar(64) NOT NULL,
    `dataset_run_id` varchar(64) NOT NULL,
    `id` varchar(64) NOT NULL,
    `dataset_item_id` varchar(64),
    `trace_id` varchar(64),
    `observation_id` String,
    `error` String,
    `created_at` DateTime(3) DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DateTime(3) DEFAULT CURRENT_TIMESTAMP(3),
    `dataset_run_name` String,
    `dataset_run_description` String,
    `dataset_run_metadata` Map<String, String>,
    `dataset_run_created_at` DateTime(3),
    `dataset_item_input` String,
    `dataset_item_expected_output` String,
    `dataset_item_metadata` Map<String, String>,
    `dataset_item_version` DateTime(3),
    `event_ts` DateTime(3),
    `is_deleted` int,
    INDEX idx_dataset_item (`dataset_item_id`) USING INVERTED COMMENT 'inverted index for dataset_item_id',
    INDEX idx_trace_id (`trace_id`) USING INVERTED COMMENT 'inverted index for trace_id',
    INDEX idx_project_id (`project_id`) USING INVERTED COMMENT 'inverted index for project_id'
) ENGINE=OLAP
UNIQUE KEY(`project_id`, `dataset_id`, `dataset_run_id`, `id`)
DISTRIBUTED BY HASH(project_id) BUCKETS 8
PROPERTIES (
"replication_allocation" = "tag.location.default: 1"
);
