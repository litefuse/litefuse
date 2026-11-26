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
import { tableFor } from "../doris/tableRouting";

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
    // traces_scalar uses start_time (not timestamp). The CTE this filter
    // lands inside is FROM ${tableFor(projectId, "traces_scalar")} t, so the bare column reference
    // resolves against the traces_scalar schema.
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

  // Two-phase fast path (~10x on large projects, measured on a 50T env):
  // phase 1 picks the page's session_ids with the cheapest possible
  // aggregate (MIN(start_time) only, both time bounds pushed into the
  // scan for partition pruning), phase 2 builds the expensive array
  // aggregates for ONLY those sessions. Legal only when the page can be
  // selected from per-trace predicates alone: ordering by min_timestamp
  // and filters that apply to a trace row (time bounds, environment,
  // session_id, bookmarked). Aggregate-level filters/orderings (user_ids,
  // tags, metrics, scores) must see every session before paging → legacy.
  const traceTimestampUpperFilter: DorisDateTimeFilter | undefined =
    tracesFilter.find(
      (f) =>
        f.field === "min_timestamp" &&
        (f.operator === "<=" || f.operator === "<"),
    ) as DorisDateTimeFilter | undefined;

  const orderByTarget = orderBy
    ? sessionColsForDoris.find(
        (c) =>
          c.uiTableName === orderBy.column || c.uiTableId === orderBy.column,
      )?.select
    : undefined;

  const PUSHDOWN_FIELDS = new Set([
    "project_id",
    "min_timestamp",
    "environment",
    "session_id",
    "bookmarked",
  ]);
  const filtersPushable = !tracesFilter.some(
    (f) =>
      !PUSHDOWN_FIELDS.has(f.field) ||
      (f.field === "min_timestamp" &&
        ![">", ">=", "<", "<="].includes(f.operator)),
  );

  const twoPhaseEligible =
    (select === "rows" &&
      limit !== undefined &&
      page !== undefined &&
      !selectMetrics &&
      !requiresScoresJoin &&
      (orderByTarget === undefined || orderByTarget === "min_timestamp") &&
      filtersPushable) ||
    // count ignores ordering entirely, so only the filters must be pushable:
    // the session count = sessions with at least one trace row in the window.
    (select === "count" && filtersPushable);

  let twoPhaseQuery: string | undefined;
  if (twoPhaseEligible) {
    // Reused verbatim in BOTH phases (values are inlined, so repetition is
    // safe): phase 2 keeps only the lower time bound, preserving the legacy
    // semantics that max_timestamp/trace_ids include traces after the
    // window's end.
    const sharedFilterList = tracesFilter.filter((f) =>
      ["environment", "session_id", "bookmarked"].includes(f.field),
    );
    if (traceTimestampFilter) {
      sharedFilterList.push(
        new DorisDateTimeFilter({
          table: "traces",
          field: "start_time",
          operator: traceTimestampFilter.operator,
          value: traceTimestampFilter.value,
        }),
      );
    }
    const sharedClause = sharedFilterList.apply().query;
    // Upper bound goes into phase 1's scan only. Pre-aggregation filtering
    // is equivalent to HAVING min <= upper: a session with any row in the
    // window has its min inside it; one with none has min above the upper
    // bound and would be dropped anyway.
    const upperClause = traceTimestampUpperFilter
      ? new DorisDateTimeFilter({
          table: "traces",
          field: "start_time",
          operator: traceTimestampUpperFilter.operator,
          value: traceTimestampUpperFilter.value,
        }).apply().query
      : "";

    twoPhaseQuery =
      select === "count"
        ? `
        SELECT count(DISTINCT session_id) as count
        FROM ${tableFor(projectId, "traces_scalar")}
        WHERE project_id = {projectId: String}
          AND session_id IS NOT NULL AND session_id != ''
          ${sharedClause ? `AND ${sharedClause}` : ""}
          ${upperClause ? `AND ${upperClause}` : ""}
          `
        : `
        WITH top_sessions AS (
          -- Expose the session key as top_session_id, NOT session_id: phase 2
          -- reuses sharedClause verbatim, and that fragment references the
          -- column bare (no table prefix). If top_sessions also exposed
          -- session_id, the phase-2 join (traces_scalar t JOIN top_sessions s)
          -- would make bare session_id ambiguous. Renaming the key here leaves
          -- t.session_id as the only session_id in scope, so the shared bare
          -- clause resolves unambiguously in both phases.
          SELECT session_id AS top_session_id, MIN(start_time) AS min_timestamp
          FROM ${tableFor(projectId, "traces_scalar")}
          WHERE project_id = {projectId: String}
            AND session_id IS NOT NULL AND session_id != ''
            ${sharedClause ? `AND ${sharedClause}` : ""}
            ${upperClause ? `AND ${upperClause}` : ""}
          GROUP BY session_id
          ${dorisOrderBy}
          LIMIT {limit: Int32} OFFSET {offset: Int32}
        ),
        session_data AS (
          -- min_timestamp reuses phase 1's value so the final sort key is
          -- exactly the one the page was selected by.
          SELECT
            t.session_id,
            any_value(t.project_id) as project_id,
            max(t.start_time) as max_timestamp,
            any_value(s.min_timestamp) as min_timestamp,
            collect_list(t.id) AS trace_ids,
            collect_set(CASE WHEN t.user_id IS NOT NULL AND t.user_id != '' THEN t.user_id ELSE NULL END) AS user_ids,
            count(*) as trace_count,
            array_remove(group_array_union(t.tags), '') AS trace_tags,
            any_value(t.environment) as trace_environment
          FROM ${tableFor(projectId, "traces_scalar")} t
          INNER JOIN top_sessions s ON t.session_id = s.top_session_id
          WHERE t.project_id = {projectId: String}
            ${sharedClause ? `AND ${sharedClause}` : ""}
          GROUP BY t.session_id
        )
        SELECT * FROM session_data
        ${dorisOrderBy}
          `;
  }

  // Doris version with database-specific adaptations
  // Note: usage/cost key matching uses substring matching (LIKE '%input%') instead
  // of exact key matching, to include keys like cache_read_input_tokens and
  // cache_creation_input_tokens — mirroring upstream's positionCaseInsensitive behavior.
  const query =
    twoPhaseQuery ??
    `
        WITH filtered_traces AS (
          -- One row per trace from the scalar split target (migration 0039 — the root
          -- span's scalars, written by the OTel-lane job) instead of an
          -- is_root = 1 event-table scan.
          -- Sessionless traces are excluded HERE, matching upstream (CH
          -- session_id is Nullable and the query keeps IS NOT NULL rows).
          -- traces_scalar stores NULL for unset ('' guarded defensively);
          -- without this exclusion every sessionless trace collapses into a
          -- single '' group whose collect_list(trace_ids) aggregation state
          -- grows with the whole project — the sessions list OOMs at scale.
          -- Project start_time without aliasing to "timestamp" so the
          -- singleTraceFilter SQL (which references the bare column name
          -- start_time) works identically in this CTE body AND in the
          -- session_data WHERE clause below — both query against
          -- filtered_traces. Aliasing here previously broke the second
          -- usage with "Unknown column 'start_time'".
          SELECT id, session_id, project_id,
                 bookmarked, start_time,
                 COALESCE(user_id, '') AS user_id, tags, environment
          FROM ${tableFor(projectId, "traces_scalar")} t
          WHERE t.project_id = {projectId: String}
            AND t.session_id IS NOT NULL AND t.session_id != ''
            ${singleTraceFilter?.query ? ` AND ${singleTraceFilter.query}` : ""}
        ),
        ${
          selectMetrics
            ? `observations_agg AS (
            -- Per-trace metrics in the trace_metrics_agg sync-MV rewrite
            -- shape (migration 0040): every aggregate is expression-identical
            -- to the MV definition and the WHERE only references MV key
            -- expressions (day-truncated bound), so Doris transparently
            -- rewrites this scan onto the rollup. The CTE must contain ONLY
            -- this scan — no IN (filtered_traces) membership pre-filter, no
            -- JOIN — or the rewrite breaks; the LEFT JOIN below discards the
            -- extra traces. No COALESCE inside the SUMs either (breaks the
            -- expression match); the 0-for-NULL guard moved to the outer
            -- session-level sums.
            -- Semantics deltas vs the old is_root = 0 CTE, both deliberate:
            --   * min_start_time/max_end_time now span ALL rows incl. the
            --     root, so duration = the full trace window — same definition
            --     the migrated traces list uses for latency (OTel root spans
            --     cover the whole trace).
            --   * obs_count keeps non-root-only semantics via the MV's
            --     SUM(CASE WHEN is_root = 0 …) column.
            SELECT project_id,
                  trace_id,
                  SUM(CASE WHEN is_root = 0 THEN 1 ELSE 0 END) as obs_count,
                  MIN(start_time) as min_start_time,
                  MAX(end_time) as max_end_time,
                  SUM(input_tokens_calculated) as sum_input_usage,
                  SUM(output_tokens_calculated) as sum_output_usage,
                  SUM(total_tokens_calculated) as sum_total_usage,
                  SUM(input_cost_calculated) as sum_input_cost,
                  SUM(output_cost_calculated) as sum_output_cost,
                  SUM(total_cost) as sum_total_cost
            FROM ${tableFor(projectId, "spans")}
            WHERE project_id = {projectId: String}
            ${traceTimestampFilter ? `AND date_trunc(start_time, 'day') >= date_trunc(DATE_SUB({observationsStartTime: DateTime}, INTERVAL 2 DAY), 'day')` : ""}
            GROUP BY project_id, trace_id
          ),`
            : ""
        }
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
                -- No DISTINCT needed on t.id: traces_scalar is MoW UNIQUE
                -- KEY(project_id, id) — one row per trace — and both joins
                -- are 1:1 (observations_agg groups by trace, scores_agg by
                -- session), so rows never multiply.
                collect_list(t.id) AS trace_ids,
                collect_set(CASE WHEN t.user_id IS NOT NULL AND t.user_id != '' THEN t.user_id ELSE NULL END) AS user_ids,
                count(*) as trace_count,
                -- Union+dedup of the session's trace tags in one aggregate
                -- (upstream groupUniqArrayArray equivalent). Unlike the former
                -- LATERAL VIEW EXPLODE_OUTER CTE this adds no rows before the
                -- observations join, so it can live in this GROUP BY without
                -- multiplying cost/token sums.
                array_remove(group_array_union(t.tags), '') AS trace_tags,
                any_value(t.environment) as trace_environment
                ${
                  selectMetrics
                    ? `
                ,
                -- obs_count counts non-root spans; each trace row adds its root span.
                COALESCE(sum(o.obs_count), 0) + count(*) as total_observations,
                -- Use Doris seconds_diff for duration calculation
                seconds_diff(
                  max(o.max_end_time),
                  CASE WHEN min(o.min_start_time) > '1970-01-01' THEN min(o.min_start_time) ELSE NULL END
                ) as duration,
                -- The 0-for-NULL guard lives HERE, not in observations_agg's
                -- SUMs (a COALESCE there would break the sync-MV expression
                -- match): a trace whose spans carry no token/cost values
                -- yields NULL per-trace sums, and CONCAT would swallow the
                -- whole JSON string on a single NULL.
                CONCAT('{"input":', CAST(COALESCE(sum(o.sum_input_usage), 0) AS STRING), ',"output":', CAST(COALESCE(sum(o.sum_output_usage), 0) AS STRING), ',"total":', CAST(COALESCE(sum(o.sum_total_usage), 0) AS STRING), '}') as session_usage_details,
                CONCAT('{"input":', CAST(COALESCE(sum(o.sum_input_cost), 0) AS STRING), ',"output":', CAST(COALESCE(sum(o.sum_output_cost), 0) AS STRING), ',"total":', CAST(COALESCE(sum(o.sum_total_cost), 0) AS STRING), '}') as session_cost_details,
                COALESCE(sum(o.sum_input_cost), 0) as session_input_cost,
                COALESCE(sum(o.sum_output_cost), 0) as session_output_cost,
                COALESCE(sum(o.sum_total_cost), 0) as session_total_cost,
                COALESCE(sum(o.sum_input_usage), 0) as session_input_usage,
                COALESCE(sum(o.sum_output_usage), 0) as session_output_usage,
                COALESCE(sum(o.sum_total_usage), 0) as session_total_usage`
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
                  SELECT ${sqlSelect.includes("trace_tags") ? "s.*" : sqlSelect}
        FROM session_data s
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
          } catch {
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
