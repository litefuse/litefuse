# Scheduled Parquet exports

In **Project Settings → Integrations → Blob Storage**, set **File Type** to
**Parquet**. The Public API accepts `"fileType": "PARQUET"` on
`PUT /api/public/integrations/blob-storage`. A format change takes effect on
the next export and continues from the integration's current sync position.

Each configured export source produces one file per table and completed time
window. For example, an enriched observations export can write
`exports/<project-id>/observations_v2/2026-11-15T01-02-03.123Z.parquet` and the
corresponding file under `scores/`. Legacy exports include `traces/` and
`observations/`. Selecting both observation sources produces all four files.
A table with no rows in an eligible window produces a zero-row file with its
schema. Both ends of the time window are inclusive, so records on the shared
boundary can appear in adjacent files.

Parquet uses internal Snappy compression. The integration's gzip flag and
observation field groups have no effect on the Parquet files.

## Schema

`TIMESTAMP_MILLIS` stores milliseconds since the UTC epoch. Readers such
as DuckDB can expose these values as timezone-less `TIMESTAMP` columns.
Interpret those values as UTC. All columns are nullable except the columns
listed as required below. `tags` is a
standard Parquet list with nullable string elements. A null list, an empty
list, and a list with a null or empty string element are distinct.

The `input`, `output`, and `model_parameters` columns preserve stored text.
`metadata` is JSON text with nested object keys flattened into dot paths
such as `{"request.source":"sdk"}`. Arrays and their contents are preserved.
`usage_details` and `cost_details` are JSON objects whose non-null values are
strings, preserving large integers and exact decimals. For example,
`{"input":"9007199254740993"}` and `{"total":"0.000000000001"}` preserve the
original values. SQL NULL remains a Parquet null.

| File | Required columns | Other UTF-8 columns | Other typed columns |
| --- | --- | --- | --- |
| `traces` | `project_id` (UTF-8), `timestamp` (TIMESTAMP_MILLIS) | `id`, `name`, `environment`, `metadata`, `user_id`, `session_id`, `release`, `version`, `input`, `output` | `public`, `bookmarked` (BOOLEAN), `tags` (LIST of UTF-8) |
| `observations` | `id`, `project_id` (UTF-8), `start_time` (TIMESTAMP_MILLIS) | `trace_id`, `environment`, `type`, `parent_observation_id`, `name`, `metadata`, `level`, `status_message`, `version`, `input`, `output`, `provided_model_name`, `model_parameters`, `usage_details`, `cost_details`, `prompt_name` | `end_time`, `completion_start_time` (TIMESTAMP_MILLIS), `prompt_version` (INT32) |
| `observations_v2` | `id` (UTF-8), `start_time` (TIMESTAMP_MILLIS) | `trace_id`, `name`, `type`, `level`, `version`, `environment`, `user_id`, `session_id`, `release`, `trace_name`, `input`, `output`, `metadata`, `model`, `prompt_name`, `status_message`, `parent_observation_id`, `event_version` | `tags` (LIST of UTF-8), `total_cost` (DECIMAL(38,12)), `latency` (INT64, milliseconds), `end_time` (TIMESTAMP_MILLIS), `prompt_version` (INT32) |
| `scores` | `project_id` (UTF-8), `timestamp` (TIMESTAMP_MILLIS) | `id`, `environment`, `trace_id`, `observation_id`, `name`, `source`, `comment`, `data_type`, `string_value` | `value` (FLOAT) |

For example, query downloaded files with DuckDB.

```sql
SELECT
  trace_id,
  start_time,
  total_cost,
  json_extract_string(metadata, '$."request.source"') AS request_source
FROM read_parquet('observations_v2/*.parquet')
WHERE start_time >= TIMESTAMP '2026-11-15 00:00:00';
```
