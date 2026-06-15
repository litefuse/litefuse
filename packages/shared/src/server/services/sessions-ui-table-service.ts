import { OrderByState } from "../../interfaces/orderBy";
import { sessionColsForDoris } from "../tableMappings/mapSessionTable";
import { FilterState } from "../../types";
import { FilterList } from "../queries";

// Doris imports
import { convertDateToAnalyticsDateTime } from "../repositories/analytics";
import { queryDoris } from "../repositories/doris";
import {
  createDorisFilterFromFilterState,
  getDorisProjectIdDefaultFilter,
} from "../queries/doris-sql/factory";
import { DateTimeFilter as DorisDateTimeFilter } from "../queries/doris-sql/doris-filter";
import { orderByToDorisSQL } from "../queries/doris-sql/orderby-factory";
import { parseDorisStringArray } from "../utils/dorisArrays";

export type SessionDataReturnType = {
  session_id: string;
  max_timestamp: string;
  min_timestamp: string;
  trace_ids: string[];
  user_ids: string[];
  trace_count: number;
  trace_tags: string[];
  trace_environment?: string;
  scores_avg?: Array<Array<[string, number]>>;
  score_categories?: Array<Array<string>>;
};

export type SessionWithMetricsReturnType = SessionDataReturnType & {
  total_observations: number;
  duration: number;
  session_usage_details: Record<string, number>;
  session_cost_details: Record<string, number>;
  session_input_cost: string;
  session_output_cost: string;
  session_total_cost: string;
  session_input_usage: string;
  session_output_usage: string;
  session_total_usage: string;
};

export const getSessionsTableCount = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}) => {
  const rows = await getSessionsTableGeneric<{ count: string }>({
    select: "count",
    projectId: props.projectId,
    filter: props.filter,
    orderBy: props.orderBy,
    limit: props.limit,
    page: props.page,
    tags: { kind: "count" },
  });

  return rows.length > 0 ? Number(rows[0].count) : 0;
};

export const getSessionsTable = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}) => {
  const rows = await getSessionsTableGeneric<SessionDataReturnType>({
    select: "rows",
    projectId: props.projectId,
    filter: props.filter,
    orderBy: props.orderBy,
    limit: props.limit,
    page: props.page,
    tags: { kind: "list" },
  });

  return rows.map((row) => ({
    ...row,
    trace_count: Number(row.trace_count),
  }));
};

export const getSessionsWithMetrics = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}) => {
  const rows = await getSessionsTableGeneric<SessionWithMetricsReturnType>({
    select: "metrics",
    projectId: props.projectId,
    filter: props.filter,
    orderBy: props.orderBy,
    limit: props.limit,
    page: props.page,
    tags: { kind: "analytic" },
  });

  return rows.map((row) => ({
    ...row,
    trace_count: Number(row.trace_count),
    total_observations: Number(row.total_observations),
  }));
};

export type FetchSessionsTableProps = {
  select: "count" | "rows" | "metrics";
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
  tags?: Record<string, string>;
};

const getSessionsTableGeneric = async <T>(props: FetchSessionsTableProps) => {
  const { select, projectId, filter, orderBy, limit, page } = props;

  // Doris implementation
  let sqlSelect: string;
  switch (select) {
    case "count":
      sqlSelect = "count(session_id) as count";
      break;
    case "rows":
      sqlSelect = `
            session_id, 
            max_timestamp, 
            min_timestamp, 
            trace_ids, 
            user_ids, 
            trace_count, 
            trace_tags,
            trace_environment`;
      break;
    case "metrics":
      sqlSelect = `
          session_id, 
          max_timestamp, 
          min_timestamp, 
          trace_ids, 
          user_ids, 
          trace_count, 
          trace_tags,
          trace_environment,
          total_observations,
          duration,
          session_usage_details,
          session_cost_details,
          session_input_cost,
          session_output_cost,
          session_total_cost,
          session_input_usage,
          session_output_usage,
          session_total_usage`;
      break;
    default: {
      const exhaustiveCheckDefault: never = select;
      throw new Error(`Unknown select type: ${exhaustiveCheckDefault}`);
    }
  }

  const { tracesFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "s",
  });

  tracesFilter.push(
    ...createDorisFilterFromFilterState(filter, sessionColsForDoris),
  );

  const tracesFilterRes = tracesFilter
    .filter((f) => f.field !== "environment")
    .apply();

  const traceTimestampFilter: DorisDateTimeFilter | undefined =
    tracesFilter.find(
      (f) =>
        f.field === "min_timestamp" &&
        (f.operator === ">=" || f.operator === ">"),
    ) as DorisDateTimeFilter | undefined;

  const filters = [];
  if (traceTimestampFilter) {
    // events_full uses start_time (not timestamp). The CTE this filter
    // lands inside is FROM events_full t, so the bare column reference
    // resolves against the events_full schema.
    filters.push(
      new DorisDateTimeFilter({
        table: "traces",
        field: "start_time",
        operator: traceTimestampFilter.operator,
        value: traceTimestampFilter.value,
      }),
    );
  }

  const additionalSingleTraceFilter = tracesFilter.find(
    (f) =>
      f.field === "bookmarked" ||
      f.field === "session_id" ||
      f.field === "environment",
  );

  if (additionalSingleTraceFilter) {
    filters.push(additionalSingleTraceFilter);
  }

  const singleTraceFilter =
    filters.length > 0 ? new FilterList(filters).apply() : undefined;

  const hasMetricsFilter =
    tracesFilter.find((f) =>
      [
        "session_total_cost",
        "session_input_cost",
        "session_output_cost",
        "duration",
        "session_total_usage",
        "session_output_usage",
        "session_input_usage",
      ].includes(f.field),
    ) ||
    (orderBy &&
      [
        "totalCost",
        "inputCost",
        "outputCost",
        "sessionDuration",
        "totalTokens",
        "outputTokens",
        "inputTokens",
        "usage",
      ].includes(orderBy?.column));

  const selectMetrics = select === "metrics" || hasMetricsFilter;

  const requiresScoresJoin =
    tracesFilter.find((f) => f.table === "scores") !== undefined ||
    sessionColsForDoris.find(
      (c) =>
        c.uiTableName === orderBy?.column || c.uiTableId === orderBy?.column,
    )?.tableName === "scores";

  const dorisOrderBy = orderByToDorisSQL(
    orderBy ? [orderBy] : null,
    sessionColsForDoris,
  );

  // Doris version with database-specific adaptations
  // Note: Tag aggregation is done in a separate CTE (session_tags) to avoid
  // LATERAL VIEW EXPLODE_OUTER duplicating rows before the observations join,
  // which would multiply cost/token metrics by the number of tags per trace.
  // Also, usage/cost key matching uses substring matching (LIKE '%input%') instead
  // of exact key matching, to include keys like cache_read_input_tokens and
  // cache_creation_input_tokens — mirroring upstream's positionCaseInsensitive behavior.
  const query = `
        WITH filtered_traces AS (
          -- Doris Unique Key + Merge-on-Write guarantees a single row per
          -- (project_id, start_time_date, span_id). The legacy CK-style
          -- ROW_NUMBER() OVER (PARTITION BY trace_id ORDER BY event_ts DESC)
          -- dedup is unnecessary here; the only residual edge case is a
          -- single trace whose start_time crosses a monthly partition
          -- boundary (multiple start_time_date rows for the same
          -- trace_id) — extremely rare in practice and considered
          -- acceptable noise.
          -- Project start_time without aliasing to "timestamp" so the
          -- singleTraceFilter SQL (which references the bare column name
          -- start_time) works identically in this CTE body AND in the
          -- session_data WHERE clause below — both query against
          -- filtered_traces. Aliasing here previously broke the second
          -- usage with "Unknown column 'start_time'".
          SELECT trace_id AS id, session_id, project_id, bookmarked,
                 start_time,
                 user_id, tags, environment, event_ts
          FROM events_full t
          WHERE t.session_id IS NOT NULL
            AND t.project_id = {projectId: String}
            AND t.parent_span_id = ''
            ${singleTraceFilter?.query ? ` AND ${singleTraceFilter.query}` : ""}
        ),
        ${
          selectMetrics
            ? `filtered_observations AS (
            SELECT span_id AS id, trace_id, project_id, start_time, end_time, usage_details, cost_details, total_cost, event_ts
            FROM events_full o
            WHERE o.project_id = {projectId: String}
            AND o.parent_span_id != ''
            ${traceTimestampFilter ? `AND o.start_time >= DATE_SUB({observationsStartTime: DateTime}, INTERVAL 2 DAY)` : ""}
            AND o.trace_id IN (
              SELECT id
              FROM filtered_traces
            )
          ),
          observations_agg AS (
            SELECT o.trace_id,
                  count(*) as obs_count,
                  min(o.start_time) as min_start_time,
                  max(o.end_time) as max_end_time,
                  -- Use substring matching on map keys to include all input/output related keys
                  -- (e.g. input, cache_read_input_tokens, cache_creation_input_tokens)
                  -- mirroring upstream's positionCaseInsensitive behavior
                  sum(COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%input%', map_values(usage_details), map_keys(usage_details))), 0)) as sum_input_usage,
                  sum(COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%output%', map_values(usage_details), map_keys(usage_details))), 0)) as sum_output_usage,
                  sum(CASE WHEN MAP_CONTAINS_KEY(usage_details,'total') THEN usage_details['total'] ELSE 0 END) as sum_total_usage,
                  sum(COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%input%', map_values(cost_details), map_keys(cost_details))), 0)) as sum_input_cost,
                  sum(COALESCE(array_sum(array_filter((v, k) -> lower(k) LIKE '%output%', map_values(cost_details), map_keys(cost_details))), 0)) as sum_output_cost,
                  -- total_cost is a denormalized column on events_full populated by the ingestion writer
                  -- (cost_details['total']). Use it directly instead of re-extracting from the map.
                  sum(COALESCE(o.total_cost, 0)) as sum_total_cost,
                  any_value(project_id) as project_id
            FROM filtered_observations o
            WHERE o.project_id = {projectId: String}
            ${traceTimestampFilter ? `AND o.start_time >= DATE_SUB({observationsStartTime: DateTime}, INTERVAL 2 DAY)` : ""}
            GROUP BY o.trace_id
          ),`
            : ""
        }
        session_tags AS (
          SELECT
            t.session_id as tag_session_id,
            collect_set(
              CASE
                WHEN tag_exploded.tag IS NOT NULL AND tag_exploded.tag != ''
                THEN tag_exploded.tag
                ELSE NULL
              END
            ) as trace_tags
          FROM filtered_traces t
          LATERAL VIEW EXPLODE_OUTER(t.tags) tag_exploded AS tag
          GROUP BY t.session_id
        ),
        ${
          requiresScoresJoin
            ? `scores_agg AS (
          -- Aggregate scores by scores.session_id, mirroring upstream.
          -- Trace-level scores (session_id NULL) aggregate into a NULL group that
          -- the outer LEFT JOIN (t.session_id = s.score_session_id) silently drops,
          -- so the Sessions list only reflects scores attached directly to a
          -- session — same behavior as upstream.
          SELECT
            score_session_id,
            any_value(project_id) as project_id,
            collect_list(CASE WHEN data_type IN ('NUMERIC', 'BOOLEAN') THEN
              struct(name, avg_value) END) AS scores_avg,
            collect_list(CASE WHEN data_type = 'CATEGORICAL' AND string_value IS NOT NULL AND string_value != '' THEN
              CONCAT(name, ':', string_value) ELSE NULL END) AS score_categories
          FROM (
            SELECT
              s.session_id AS score_session_id,
              s.project_id,
              s.name,
              avg(s.value) avg_value,
              s.string_value,
              s.data_type
            FROM scores s
            WHERE s.project_id = {projectId: String}
              ${traceTimestampFilter ? `AND s.timestamp >= DATE_SUB({observationsStartTime: DateTime}, INTERVAL 2 DAY)` : ""}
            GROUP BY s.session_id, s.project_id, s.name, s.string_value, s.data_type
          ) tmp
          GROUP BY score_session_id
        ),`
            : ""
        }
        session_data AS (
            SELECT
                t.session_id,
                any_value(t.project_id) as project_id,
                max(t.start_time) as max_timestamp,
                min(t.start_time) as min_timestamp,
                collect_list(DISTINCT t.id) AS trace_ids,
                collect_set(CASE WHEN t.user_id IS NOT NULL AND t.user_id != '' THEN t.user_id ELSE NULL END) AS user_ids,
                count(DISTINCT t.id) as trace_count,
                any_value(t.environment) as trace_environment
                ${
                  selectMetrics
                    ? `
                ,
                sum(o.obs_count) as total_observations,
                -- Use Doris seconds_diff for duration calculation
                seconds_diff(
                  max(o.max_end_time),
                  CASE WHEN min(o.min_start_time) > '1970-01-01' THEN min(o.min_start_time) ELSE NULL END
                ) as duration,
                -- JSON string representation for usage details
                CONCAT('{"input":', CAST(sum(o.sum_input_usage) AS STRING), ',"output":', CAST(sum(o.sum_output_usage) AS STRING), ',"total":', CAST(sum(o.sum_total_usage) AS STRING), '}') as session_usage_details,
                -- JSON string representation for cost details
                CONCAT('{"input":', CAST(sum(o.sum_input_cost) AS STRING), ',"output":', CAST(sum(o.sum_output_cost) AS STRING), ',"total":', CAST(sum(o.sum_total_cost) AS STRING), '}') as session_cost_details,
                sum(o.sum_input_cost) as session_input_cost,
                sum(o.sum_output_cost) as session_output_cost,
                sum(o.sum_total_cost) as session_total_cost,
                sum(o.sum_input_usage) as session_input_usage,
                sum(o.sum_output_usage) as session_output_usage,
                sum(o.sum_total_usage) as session_total_usage`
                    : ""
                }
                ${
                  requiresScoresJoin
                    ? `,
                any_value(sc.scores_avg) as scores_avg,
                any_value(sc.score_categories) as score_categories`
                    : ""
                }
            FROM filtered_traces t
            ${
              selectMetrics
                ? `LEFT JOIN observations_agg o
            ON t.id = o.trace_id AND t.project_id = o.project_id`
                : ""
            }
            ${
              requiresScoresJoin
                ? `LEFT JOIN scores_agg sc
            ON sc.score_session_id = t.session_id AND sc.project_id = t.project_id`
                : ""
            }
            WHERE t.session_id IS NOT NULL
                AND t.project_id = {projectId: String}
                ${singleTraceFilter?.query ? ` AND ${singleTraceFilter.query}` : ""}
            GROUP BY t.session_id
        )
                  SELECT ${sqlSelect.includes("trace_tags") ? `s.*, st.trace_tags` : sqlSelect}
        FROM session_data s
        LEFT JOIN session_tags st ON s.session_id = st.tag_session_id
        WHERE ${tracesFilterRes.query ? tracesFilterRes.query : "1=1"}
        ${dorisOrderBy}
        ${limit !== undefined && page !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
          `;

  const obsStartTimeValue = traceTimestampFilter
    ? convertDateToAnalyticsDateTime(traceTimestampFilter.value)
    : null;

  const res = await queryDoris<T>({
    query: query,
    params: {
      projectId,
      limit: limit,
      offset: limit && page ? limit * page : 0,
      ...tracesFilterRes.params,
      ...singleTraceFilter?.params,
      ...(obsStartTimeValue
        ? { observationsStartTime: obsStartTimeValue }
        : {}),
    },
    tags: {
      ...(props.tags ?? {}),
      feature: "tracing",
      type: "sessions-table",
      projectId,
    },
  });

  const parseDetailsField = (
    details: string | Record<string, number>,
  ): Record<string, number> => {
    if (!details) return {};
    if (typeof details === "object" && !Array.isArray(details)) return details;
    if (typeof details === "string") {
      try {
        const parsed = JSON.parse(details.trim());
        if (typeof parsed === "object" && !Array.isArray(parsed)) {
          const result: Record<string, number> = {};
          for (const [key, value] of Object.entries(parsed)) {
            result[key] = Number(value) || 0;
          }
          return result;
        }
      } catch {
        /* ignore parse errors */
      }
    }
    return {};
  };

  // Post-process Doris results into the object shape downstream consumers expect
  if (select === "metrics") {
    const processedRes = (
      res as Array<
        SessionWithMetricsReturnType & {
          session_usage_details: string | Record<string, number>;
          session_cost_details: string | Record<string, number>;
        }
      >
    ).map((row) => {
      // Helper function to parse details fields (session_usage_details, session_cost_details)
      const parseDetails = (
        details: string | Record<string, number>,
      ): Record<string, number> => {
        if (!details) {
          return {};
        }

        // If already an object, return as is
        if (typeof details === "object" && !Array.isArray(details)) {
          return details;
        }

        // If it's a string (Doris format), parse it
        if (typeof details === "string") {
          const trimmed = details.trim();

          // Handle common null/empty cases
          if (!trimmed || trimmed === "null" || trimmed === "NULL") {
            return {};
          }

          // Handle empty object/array cases
          if (trimmed === "{}" || trimmed === "[]") {
            return {};
          }

          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === "object" && !Array.isArray(parsed)) {
              // Convert values to numbers
              const result: Record<string, number> = {};
              for (const [key, value] of Object.entries(parsed)) {
                result[key] = Number(value) || 0;
              }
              return result;
            }
            return {};
          } catch (error) {
            return {};
          }
        }

        return {};
      };

      // Return row with parsed object values
      return {
        ...row,
        session_usage_details: parseDetails(row.session_usage_details),
        session_cost_details: parseDetails(row.session_cost_details),
        // Ensure array fields are always arrays and filter out null values
        trace_tags: parseDorisStringArray(row.trace_tags as any),
        user_ids: parseDorisStringArray(row.user_ids as any),
        trace_ids: parseDorisStringArray(row.trace_ids as any),
      } as SessionWithMetricsReturnType;
    });

    return processedRes as T[];
  }

  // Post-process Doris results for rows
  if (select === "rows") {
    const processedRes = (
      res as Array<
        SessionDataReturnType & {
          trace_tags: string[] | string | null;
        }
      >
    ).map(
      (row) =>
        ({
          ...row,
          trace_tags: parseDorisStringArray(row.trace_tags),
          user_ids: parseDorisStringArray(row.user_ids),
          trace_ids: parseDorisStringArray(row.trace_ids),
        }) as SessionDataReturnType,
    );

    return processedRes as T[];
  }

  return res;
};
