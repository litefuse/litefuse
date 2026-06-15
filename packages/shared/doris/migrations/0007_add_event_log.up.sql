CREATE TABLE IF NOT EXISTS event_log
(
    `id`          varchar(65533),
    `project_id`  varchar(65533),
    `entity_type` String,
    `entity_id`   String,
    `event_id`    String,

    `bucket_name` String,
    `bucket_path` String,

    `created_at`  DateTime DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DateTime DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_entity_id (`entity_id`) USING INVERTED COMMENT 'inverted index for entity_id',
    INDEX idx_entity_type (`entity_type`) USING INVERTED COMMENT 'inverted index for entity_type'
) ENGINE=OLAP
DUPLICATE KEY(`id`, `project_id`)
DISTRIBUTED BY HASH(`project_id`) BUCKETS AUTO
PROPERTIES (
"replication_allocation" = "tag.location.default: 1"
);
