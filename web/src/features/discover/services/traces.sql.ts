// @ts-nocheck
import {
  QueryTracesParams,
  TracesOperationsParams,
  TracesServicesParams,
} from "types/type";

interface QueryTraceDetailParams {
  database: string;
  table: string;
  trace_id: string;
}

// Query trace details for a given table
export function getQueryTableTraceSQL(params: QueryTraceDetailParams): string {
  const { table, trace_id, database } = params;

  const sql = `
      SELECT
        trace_id AS traceID,
        span_id AS spanID,
        parent_span_id AS parentSpanID,
        span_name AS operationName,
        service_name AS serviceName,
        CONCAT(
          '[',
          array_join(
            array_map(
              (x, y) -> json_object('key', x, 'value', y),
              map_keys(CAST(CAST(resource_attributes AS TEXT) AS MAP<STRING, STRING>)),
              map_values(CAST(CAST(resource_attributes AS TEXT) AS MAP<STRING, STRING>))
            ),
            ','
          ),
          ']'
        ) AS serviceTags,
        UNIX_TIMESTAMP(timestamp) * 1000 AS startTime,
        duration / 1000 AS duration,
        CONCAT(
          '[',
          array_join(
            array_map(
              (x, y) -> json_object('key', x, 'value', y),
              map_keys(CAST(CAST(span_attributes AS TEXT) AS MAP<STRING, STRING>)),
              map_values(CAST(CAST(span_attributes AS TEXT) AS MAP<STRING, STRING>))
            ),
            ','
          ),
          ']'
        ) AS tags,
        span_kind AS kind,
        CASE status_code
          WHEN 'STATUS_CODE_OK' THEN 1
          WHEN 'STATUS_CODE_ERROR' THEN 2
          ELSE 0
        END AS statusCode,
        status_message AS statusMessage,
        scope_name AS instrumentationLibraryName,
        scope_version AS instrumentationLibraryVersion,
        trace_state AS traceState
      FROM ${database}.\`${table}\`
      WHERE trace_id = '${trace_id}';
    `;

  return sql;
}

function parseDuration(input?: string): number {
  if (!input) {
    return 0;
  }

  if (input.endsWith("ms")) {
    return parseFloat(input.replace("ms", ""));
  } else if (input.endsWith("us")) {
    return parseFloat(input.replace("us", "")) / 1000;
  } else if (input.endsWith("s")) {
    return parseFloat(input.replace("s", "")) * 1000;
  }
  return 0;
}

function tagsToDorisSQLConditions(tags?: string): string {
  if (!tags) {
    return "1=1";
  }
  const conditions: string[] = [];

  const regex = /(\w+)=([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(tags)) !== null) {
    const key = match[1];
    const val = match[2];
    conditions.push(`span_attributes['${key}'] = '${val}'`);
  }

  return conditions.length > 0 ? conditions.join(" AND ") : "1=1";
}

export function buildTraceAggSQLFromParams(params: QueryTracesParams): string {
  const timeFilter = `${params.timeField} >= '${params.startDate}' AND ${params.timeField} < '${params.endDate}'`;

  const serviceFilter =
    params.service_name && params.service_name !== "all"
      ? `service_name = '${params.service_name}'`
      : "1=1";

  const operationFilter =
    params.operation && params.operation !== "all"
      ? `span_name = '${params.operation}'`
      : "1=1";

  const statusFilter =
    params.statusCode && params.statusCode !== "all"
      ? `status_code = '${params.statusCode}'`
      : "1=1";

  const minDuration = parseDuration(params.minDuration);
  const maxDuration = parseDuration(params.maxDuration);

  let durationFilter = "1=1";
  if (minDuration > 0 && maxDuration > 0) {
    durationFilter = `trace_duration BETWEEN ${minDuration} AND ${maxDuration}`;
  } else if (minDuration > 0) {
    durationFilter = `trace_duration >= ${minDuration}`;
  } else if (maxDuration > 0) {
    durationFilter = `trace_duration <= ${maxDuration}`;
  }

  const tagsFilter = tagsToDorisSQLConditions(params.tags);

  let rootSpansFilter = "1=1";
  if (params.service_name && params.service_name !== "all") {
    rootSpansFilter = `service_name = '${params.service_name}'`;
  }
  if (params.operation && params.operation !== "all") {
    rootSpansFilter += ` AND span_name = '${params.operation}'`;
  }

  const limit = params.page_size ?? 1000;
  const offset = Math.max(((params.page ?? 1) - 1) * limit, 0);

  let rowNumberOrderBy = "time DESC";
  switch (params.sortBy) {
    case "longest-duration":
      rowNumberOrderBy = "trace_duration_ms DESC";
      break;
    case "shortest-duration":
      rowNumberOrderBy = "trace_duration_ms ASC";
      break;
    case "most-spans":
      rowNumberOrderBy = "spans DESC";
      break;
    case "least-spans":
      rowNumberOrderBy = "spans ASC";
      break;
    case "most-recent":
      rowNumberOrderBy = "time DESC";
      break;
  }

  const query = `
USE ${params.database};

WITH
  trace_durations AS (
    SELECT
      trace_id,
      (UNIX_TIMESTAMP(MAX(end_time)) - UNIX_TIMESTAMP(MIN(timestamp))) * 1000 AS trace_duration
    FROM ${params.table}
    WHERE ${timeFilter}
    GROUP BY trace_id
  ),
  all_trace_ids AS (
    SELECT
      t.trace_id,
      MIN(t.${params.timeField}) AS time,
      d.trace_duration
    FROM ${params.table} t
    JOIN trace_durations d ON t.trace_id = d.trace_id
    WHERE
      ${timeFilter}
      AND ${serviceFilter}
      AND ${operationFilter}
      AND ${statusFilter}
      AND ${tagsFilter}
      AND 1=1
      AND ${durationFilter}
    GROUP BY t.trace_id, d.trace_duration
  ),
  root_spans AS (
    SELECT
      trace_id,
      span_name AS operation,
      service_name AS root_service
    FROM ${params.table}
    WHERE (parent_span_id IS NULL OR parent_span_id = '') AND ${rootSpansFilter}
  ),
  aggregated AS (
    SELECT
      UNIX_TIMESTAMP(MIN(t.${params.timeField})) AS time,
      t.trace_id,
      r.operation,
      r.root_service,
      COLLECT_SET(t.service_name) AS services,
      COUNT(*) AS spans,
      SUM(IF(status_code = 'STATUS_CODE_ERROR', 1, 0)) AS error_spans,
      MAX(duration) / 1000 AS max_span_duration_ms,
      MAX(UNIX_TIMESTAMP(t.timestamp) * 1000 + duration / 1000) - MIN(UNIX_TIMESTAMP(t.timestamp) * 1000) AS trace_duration_ms,
      MAX(IF(t.parent_span_id IS NULL OR t.parent_span_id = '', duration, 0)) / 1000 AS root_span_duration_ms
    FROM ${params.table} t
    JOIN all_trace_ids a ON t.trace_id = a.trace_id
    JOIN root_spans r ON t.trace_id = r.trace_id
    GROUP BY t.trace_id, r.operation, r.root_service
  ),
  numbered AS (
    SELECT
      a.*,
      COUNT(*) OVER() AS total_count,
      ROW_NUMBER() OVER(ORDER BY ${rowNumberOrderBy}) AS rn
    FROM aggregated a
  )

SELECT
  *,
  total_count AS total
FROM numbered
WHERE rn > ${offset} AND rn <= ${offset + limit}
ORDER BY ${rowNumberOrderBy};
`;

  return query;
}

export function getServiceListSQL(params: TracesServicesParams): string {
  return `
    SELECT DISTINCT service_name 
    FROM ${params.table} 
    WHERE ${params.timeField} BETWEEN '${params.startDate}' AND '${params.endDate}' 
    ORDER BY service_name ASC
  `;
}

export function getOperationListSQL(params: TracesOperationsParams): string {
  return `
    SELECT DISTINCT span_name 
    FROM ${params.table} 
    WHERE ${params.timeField} BETWEEN '${params.startDate}' AND '${params.endDate}' 
    AND service_name = '${params.service_name}'
    ORDER BY span_name ASC
  `;
}
