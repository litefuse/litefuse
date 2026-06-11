import { OrderByState } from "../../interfaces/orderBy";
import { tracesTableUiColumnDefinitionsForDoris } from "../tableMappings";
import { FilterState } from "../../types";

import { TraceRecordReadType } from "../repositories/definitions";
import Decimal from "decimal.js";
import { ScoreAggregate } from "../../features/scores";
import { reduceUsageOrCostDetails } from "../repositories";
import { TracingSearchType } from "../../interfaces/search";
import { ObservationLevelType, TraceDomain } from "../../domain";
// Doris imports
import { convertDateToAnalyticsDateTime, dq } from "../repositories/analytics";
import { queryDoris } from "../repositories/doris";
import { parseDorisUTCDateTimeFormat } from "../repositories/doris";
import {
  createDorisFilterFromFilterState,
  getDorisProjectIdDefaultFilter,
} from "../queries/doris-sql/factory";
import {
  StringFilter as DorisStringFilter,
  StringOptionsFilter as DorisStringOptionsFilter,
  DateTimeFilter as DorisDateTimeFilter,
} from "../queries/doris-sql/doris-filter";
import { orderByToDorisSQL } from "../queries/doris-sql/orderby-factory";
import { dorisSearchCondition } from "../queries/doris-sql/search";
import { logger } from "../logger";

export type TracesTableReturnType = Pick<
  TraceRecordReadType,
  | "project_id"
  | "id"
  | "name"
  | "timestamp"
  | "bookmarked"
  | "release"
  | "version"
  | "user_id"
  | "session_id"
  | "environment"
  | "tags"
  | "public"
>;

export type TracesTableUiReturnType = Pick<
  TraceDomain,
  | "id"
  | "projectId"
  | "timestamp"
  | "tags"
  | "bookmarked"
  | "name"
  | "release"
  | "version"
  | "userId"
  | "environment"
  | "sessionId"
  | "public"
>;

export type TracesMetricsUiReturnType = {
  id: string;
  projectId: string;
  promptTokens: bigint;
  completionTokens: bigint;
  totalTokens: bigint;
  latency: number | null;
  level: ObservationLevelType;
  observationCount: bigint;
  calculatedTotalCost: Decimal | null;
  calculatedInputCost: Decimal | null;
  calculatedOutputCost: Decimal | null;
  scores: ScoreAggregate;
  usageDetails: Record<string, number>;
  costDetails: Record<string, number>;
  errorCount: bigint;
  warningCount: bigint;
  defaultCount: bigint;
  debugCount: bigint;
};

export const convertToUiTableRows = (
  row: TracesTableReturnType,
): TracesTableUiReturnType => {
  // Doris (via mysql2) returns timestamps as Date objects, but some callers
  // (e.g. legacy paths or JSON-roundtripped rows) supply ISO strings; accept
  // both. TypeScript can't narrow Date | string at runtime so we type-assert.
  const timestampValue = row.timestamp as unknown;
  const timestamp =
    timestampValue instanceof Date
      ? (timestampValue as Date)
      : parseDorisUTCDateTimeFormat(row.timestamp as string);

  return {
    id: row.id,
    projectId: row.project_id,
    timestamp: timestamp,
    tags: row.tags ?? [],
    bookmarked: Boolean(row.bookmarked),
    name: row.name ?? null,
    release: row.release ?? null,
    version: row.version ?? null,
    userId: row.user_id ?? null,
    environment: row.environment ?? null,
    sessionId: row.session_id ?? null,
    public: Boolean(row.public),
  };
};

export type TracesTableMetricsDorisReturnType = {
  id: string;
  project_id: string;
  timestamp: Date;
  level: ObservationLevelType;
  observation_count: number | null;
  latency: string | null;
  usage_details: Record<string, number>;
  cost_details: Record<string, number>;
  scores_avg: Array<{ name: string; avg_value: number }>;
  score_categories: Array<string>;
  error_count: number | null;
  warning_count: number | null;
  default_count: number | null;
  debug_count: number | null;
};

export const convertToUITableMetrics = (
  row: TracesTableMetricsDorisReturnType,
): Omit<TracesMetricsUiReturnType, "scores"> => {
  const usageDetails = reduceUsageOrCostDetails(row.usage_details);

  return {
    id: row.id,
    projectId: row.project_id,
    latency: Number(row.latency),
    promptTokens: BigInt(usageDetails.input ?? 0),
    completionTokens: BigInt(usageDetails.output ?? 0),
    totalTokens: BigInt(usageDetails.total ?? 0),
    usageDetails: row.usage_details
      ? Object.fromEntries(
          Object.entries(row.usage_details).map(([key, value]) => [
            key,
            Number(value),
          ]),
        )
      : {},
    costDetails: row.cost_details
      ? Object.fromEntries(
          Object.entries(row.cost_details).map(([key, value]) => [
            key,
            Number(value),
          ]),
        )
      : {},
    observationCount: BigInt(row.observation_count ?? 0),
    calculatedTotalCost: row.cost_details?.total
      ? new Decimal(row.cost_details.total)
      : null,
    calculatedInputCost: row.cost_details?.input
      ? new Decimal(row.cost_details.input)
      : null,
    calculatedOutputCost: row.cost_details?.output
      ? new Decimal(row.cost_details.output)
      : null,
    level: row.level,
    debugCount: BigInt(row.debug_count ?? 0),
    warningCount: BigInt(row.warning_count ?? 0),
    errorCount: BigInt(row.error_count ?? 0),
    defaultCount: BigInt(row.default_count ?? 0),
  };
};

export type FetchTracesTableProps = {
  select: "count" | "rows" | "metrics" | "identifiers" | "largeFieldStats";
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
  tags?: Record<string, string>;
};

// Define return type mapping for better type safety
type SelectReturnTypeMap = {
  count: { count: string };
  metrics: TracesTableMetricsDorisReturnType;
  rows: TracesTableReturnType;
  identifiers: { id: string; projectId: string; timestamp: string };
  largeFieldStats: {
    avg_input_bytes: string | number | null;
    avg_output_bytes: string | number | null;
    avg_metadata_bytes: string | number | null;
  };
};

// Function overloads for type-safe select-specific returns
async function getTracesTableGeneric(
  props: FetchTracesTableProps & { select: "count" },
): Promise<Array<SelectReturnTypeMap["count"]>>;

async function getTracesTableGeneric(
  props: FetchTracesTableProps & { select: "metrics" },
): Promise<Array<SelectReturnTypeMap["metrics"]>>;

async function getTracesTableGeneric(
  props: FetchTracesTableProps & { select: "rows" },
): Promise<Array<SelectReturnTypeMap["rows"]>>;

async function getTracesTableGeneric(
  props: FetchTracesTableProps & { select: "identifiers" },
): Promise<Array<SelectReturnTypeMap["identifiers"]>>;

async function getTracesTableGeneric(
  props: FetchTracesTableProps & { select: "largeFieldStats" },
): Promise<Array<SelectReturnTypeMap["largeFieldStats"]>>;

// Implementation with union type for internal use
async function getTracesTableGeneric(
  props: FetchTracesTableProps,
): Promise<Array<SelectReturnTypeMap[keyof SelectReturnTypeMap]>>;

async function getTracesTableGeneric(props: FetchTracesTableProps) {
  const {
    select,
    projectId,
    filter,
    orderBy,
    limit,
    page,
    searchQuery,
    searchType,
  } = props;

  // Shared SELECT statement generation logic (used by Doris path)
  let sqlSelect: string;
  switch (select) {
    case "count":
      sqlSelect = "count(*) as count";
      break;
    case "metrics":
      sqlSelect = `
        t.trace_id as id,
        t.project_id as project_id,
        t.start_time as ${dq("timestamp")},
        os.latency_milliseconds / 1000 as latency,
        os.cost_details as cost_details,
        os.usage_details as usage_details,
        os.aggregated_level as level,
        os.error_count as error_count,
        os.warning_count as warning_count,
        os.default_count as default_count,
        os.debug_count as debug_count,
        os.observation_count as observation_count,
        s.scores_avg as scores_avg,
        s.score_categories as score_categories,
        t.${dq("public")} as ${dq("public")}`;
      break;
    case "rows":
      // `t` is `events_full` filtered to the root span (parent_span_id =
      // ''). `t.name` is the *root span's own* name, e.g.
      // "advanced-generation-…"; `t.trace_name` is the trace-level name
      // denormalised onto every row by createEventRecord. The trace
      // list UI must show the latter — fall back to `t.name` only when
      // the SDK didn't set a trace name (legacy clients).
      sqlSelect = `
        t.trace_id as id,
        t.project_id as project_id,
        t.start_time as ${dq("timestamp")},
        t.tags as tags,
        t.bookmarked as bookmarked,
        IF(t.trace_name <> '', t.trace_name, t.name) as name,
        t.${dq("release")} as ${dq("release")},
        t.version as version,
        t.user_id as user_id,
        t.environment as environment,
        t.session_id as session_id,
        t.${dq("public")} as ${dq("public")}`;
      break;
    case "identifiers":
      sqlSelect = `
        t.trace_id as id,
        t.project_id as projectId,
        t.start_time as ${dq("timestamp")}`;
      break;
    case "largeFieldStats":
      sqlSelect = `
        AVG(COALESCE(CHAR_LENGTH(CAST(t.input AS STRING)), 0)) as avg_input_bytes,
        AVG(COALESCE(CHAR_LENGTH(CAST(t.output AS STRING)), 0)) as avg_output_bytes,
        AVG(
          COALESCE(CHAR_LENGTH(CAST(t.metadata_names AS STRING)), 0) +
          COALESCE(CHAR_LENGTH(CAST(t.metadata_values AS STRING)), 0)
        ) as avg_metadata_bytes`;
      break;
    default:
      throw new Error(`Unknown select type: ${select}`);
  }

  const { tracesFilter, scoresFilter, observationsFilter } =
    getDorisProjectIdDefaultFilter(projectId, { tracesPrefix: "t" });

  tracesFilter.push(
    ...createDorisFilterFromFilterState(
      filter,
      tracesTableUiColumnDefinitionsForDoris,
    ),
  );

  const traceIdFilter = tracesFilter.find(
    (f) => f.table === "traces" && f.field === "id",
  ) as DorisStringFilter | DorisStringOptionsFilter | undefined;

  traceIdFilter
    ? scoresFilter.push(
        new DorisStringOptionsFilter({
          table: "scores",
          field: "trace_id",
          operator: "any of",
          values:
            traceIdFilter instanceof DorisStringFilter
              ? [traceIdFilter.value]
              : traceIdFilter.values,
        }),
      )
    : null;
  traceIdFilter
    ? observationsFilter.push(
        new DorisStringOptionsFilter({
          table: "observations",
          field: "trace_id",
          operator: "any of",
          values:
            traceIdFilter instanceof DorisStringFilter
              ? [traceIdFilter.value]
              : traceIdFilter.values,
        }),
      )
    : null;

  const timeStampFilter = tracesFilter.find(
    (f) =>
      f.field === "start_time" && (f.operator === ">=" || f.operator === ">"),
  ) as DorisDateTimeFilter | undefined;

  const requiresScoresJoin =
    tracesFilter.find((f) => f.table === "scores") !== undefined ||
    tracesTableUiColumnDefinitionsForDoris.find(
      (c) =>
        c.uiTableName === orderBy?.column || c.uiTableId === orderBy?.column,
    )?.tableName === "scores";

  const requiresObservationsJoin =
    tracesFilter.find((f) => f.table === "observations") !== undefined ||
    tracesTableUiColumnDefinitionsForDoris.find(
      (c) =>
        c.uiTableName === orderBy?.column || c.uiTableId === orderBy?.column,
    )?.tableName === "observations";

  const tracesFilterRes = tracesFilter.apply();
  const scoresFilterRes = scoresFilter.apply();
  const observationFilterRes = observationsFilter.apply();

  // Check if any filter references observation-level columns (os.usage_details etc.)
  // to add Doris optimizer hint when needed.
  const hasObsLevelFilter =
    tracesFilter.find((f) => f.table === "observations") !== undefined;

  const search = dorisSearchCondition(searchQuery, searchType, {
    type: "traces",
  });

  const defaultOrder = orderBy?.order && orderBy?.column === "timestamp";
  const orderByCols = [
    ...tracesTableUiColumnDefinitionsForDoris,
    {
      select: "DATE(t.start_time)",
      uiTableName: "timestamp_to_date",
      uiTableId: "timestamp_to_date",
      tableName: "traces",
    },
    {
      select: "t.event_ts",
      uiTableName: "event_ts",
      uiTableId: "event_ts",
      tableName: "traces",
    },
  ];
  const dorisOrderBy = orderByToDorisSQL(
    [
      defaultOrder
        ? [
            {
              column: "timestamp_to_date",
              order: orderBy.order,
            },
            { column: "timestamp", order: orderBy.order },
            { column: "event_ts", order: "DESC" as "DESC" },
          ]
        : null,
      orderBy ?? null,
    ].flat(),
    orderByCols,
  );

  // Doris version of the complex query
  const observations_stats_cte =
    select === "metrics" || requiresObservationsJoin
      ? `
      observations_stats AS (
        SELECT
          agg.trace_id,
          agg.project_id,
          agg.observation_count,
          agg.total_cost,
          agg.latency_milliseconds,
          agg.error_count,
          agg.warning_count,
          agg.default_count,
          agg.debug_count,
          agg.aggregated_level,
          usage_maps.usage_details,
          cost_maps.cost_details
        FROM (
          SELECT
            trace_id,
            project_id,
            COUNT(*) AS observation_count,
            SUM(total_cost) AS total_cost,
            -- Calculate millisecond diff in Doris - use CASE WHEN instead of least/greatest
            milliseconds_diff(
            CASE WHEN max(start_time) > max(end_time) THEN max(start_time) ELSE max(end_time) END,
            CASE WHEN min(start_time) < min(end_time) THEN min(start_time) ELSE min(end_time) END
            ) as latency_milliseconds,
            -- Conditional counts
            sum(CASE WHEN level = 'ERROR' THEN 1 ELSE 0 END) as error_count,
            sum(CASE WHEN level = 'WARNING' THEN 1 ELSE 0 END) as warning_count,
            sum(CASE WHEN level = 'DEFAULT' THEN 1 ELSE 0 END) as default_count,
            sum(CASE WHEN level = 'DEBUG' THEN 1 ELSE 0 END) as debug_count,
            -- Level aggregation
            CASE 
              WHEN ARRAY_CONTAINS(collect_list(level), 'ERROR') THEN 'ERROR'
              WHEN ARRAY_CONTAINS(collect_list(level), 'WARNING') THEN 'WARNING'
              WHEN ARRAY_CONTAINS(collect_list(level), 'DEFAULT') THEN 'DEFAULT'
              ELSE 'DEBUG'
            END AS aggregated_level
          FROM (
            SELECT
              trace_id,
              project_id,
              level,
              start_time,
              end_time,
              total_cost
            FROM events_full o
            WHERE project_id = {projectId: String}
            AND parent_span_id != ''
            ${timeStampFilter ? `AND start_time >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY)` : ""}
            ${observationFilterRes ? `AND ${observationFilterRes.query}` : ""}
          ) obs
          GROUP BY trace_id, project_id
        ) agg
        LEFT JOIN (
          SELECT trace_id, project_id,
            map_agg(usage_key, usage_sum) as usage_details
          FROM (
            SELECT o.trace_id, o.project_id, usage_key, sum(usage_value) as usage_sum
            FROM events_full o
            LATERAL VIEW explode_map(usage_details) usage_exploded AS usage_key, usage_value
            WHERE o.project_id = {projectId: String}
            AND o.parent_span_id != ''
            ${timeStampFilter ? `AND o.start_time >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY)` : ""}
            ${observationFilterRes ? `AND ${observationFilterRes.query}` : ""}
            AND usage_details IS NOT NULL
            GROUP BY o.trace_id, o.project_id, usage_key
          ) u
          GROUP BY trace_id, project_id
        ) usage_maps ON agg.trace_id = usage_maps.trace_id AND agg.project_id = usage_maps.project_id
        LEFT JOIN (
          SELECT trace_id, project_id,
            map_agg(cost_key, cost_sum) as cost_details
          FROM (
            SELECT o.trace_id, o.project_id, cost_key, sum(cost_value) as cost_sum
            FROM events_full o
            LATERAL VIEW explode_map(cost_details) cost_exploded AS cost_key, cost_value
            WHERE o.project_id = {projectId: String}
            AND o.parent_span_id != ''
            ${timeStampFilter ? `AND o.start_time >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY)` : ""}
            ${observationFilterRes ? `AND ${observationFilterRes.query}` : ""}
            AND cost_details IS NOT NULL
            GROUP BY o.trace_id, o.project_id, cost_key
          ) c
          GROUP BY trace_id, project_id
        ) cost_maps ON agg.trace_id = cost_maps.trace_id AND agg.project_id = cost_maps.project_id
      )`
      : "";

  const scores_avg_cte =
    select === "metrics" || requiresScoresJoin
      ? `
      scores_avg AS (
        SELECT
          project_id,
          trace_id,
          -- Numeric scores: Array<Struct(name, avg_value)> matching CK's
          -- Array<Tuple> so NumberObjectFilter (size(array_filter(...)) > 0)
          -- OR-matches over all evaluator rows for the same score name.
          -- collect_list skips NULLs automatically (for struct rows).
          collect_list(
            CASE WHEN data_type IN ('NUMERIC', 'BOOLEAN') THEN
              struct(name, avg_value)
            END
          ) AS scores_avg,
          -- Categorical scores: Array<"name:value"> for CategoryOptionsFilter
          -- which uses arrays_overlap(column, array(...)).
          array_except(
            collect_list(
              CASE WHEN data_type = 'CATEGORICAL' AND string_value IS NOT NULL AND string_value != '' THEN
                CONCAT(name, ':', string_value)
              ELSE NULL END
            ),
            [NULL]
          ) AS score_categories
        FROM (
          SELECT 
            project_id,
            trace_id,
            name,
            data_type,
            string_value,
            avg(value) as avg_value
          FROM scores s 
          WHERE 
            project_id = {projectId: String}
            ${timeStampFilter ? `AND s.timestamp >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 1 HOUR)` : ""}
            ${scoresFilterRes ? `AND ${scoresFilterRes.query}` : ""}
          GROUP BY 
            project_id,
            trace_id,
            name,
            data_type,
            string_value
        ) tmp
        GROUP BY project_id, trace_id
      )`
      : "";

  const withClause = [observations_stats_cte, scores_avg_cte]
    .filter(Boolean)
    .join(",\n");

  // Doris Nereids optimizer crashes with "LogicalFilter cannot be cast to
  // LogicalJoin" when complex expressions referencing LEFT JOIN columns
  // (os.usage_details with array_filter/map_keys) appear in the WHERE clause.
  // Disable PUSH_FILTER_INSIDE_JOIN rule via hint when obs-level filters exist.
  const dorisHint = hasObsLevelFilter
    ? `/*+ SET_VAR(disable_nereids_rules='PUSH_FILTER_INSIDE_JOIN') */`
    : "";

  const query = `
      ${withClause ? `WITH ${withClause}` : ""}
      SELECT ${dorisHint} ${sqlSelect}
      FROM events_full t
      ${select === "metrics" || requiresObservationsJoin ? `LEFT JOIN observations_stats os on os.project_id = t.project_id and os.trace_id = t.trace_id` : ""}
      ${select === "metrics" || requiresScoresJoin ? `LEFT JOIN scores_avg s on s.project_id = t.project_id and s.trace_id = t.trace_id` : ""}
      WHERE t.project_id = {projectId: String}
      AND t.parent_span_id = ''
      ${timeStampFilter ? `AND t.start_time_date >= DATE(DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY))` : ""}
      ${tracesFilterRes ? `AND ${tracesFilterRes.query}` : ""}
      ${search.query}
      ${dorisOrderBy}
      ${limit !== undefined && page !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
    `;

  // Define Doris-specific return type for metrics
  type DorisMetricsReturnType = Omit<
    TracesTableMetricsDorisReturnType,
    "scores_avg" | "score_categories" | "usage_details" | "cost_details"
  > & {
    // scores_avg: Array of struct objects ({col1, col2} from Doris struct), or JSON string
    scores_avg: string | Array<Record<string, unknown>>;
    score_categories: string | Array<string>; // Array<"name:value"> or JSON string
    usage_details: string | Record<string, number> | null; // Doris MAP comes back as a JSON string; accept the parsed object too for callers that pre-parse
    cost_details: string | Record<string, number> | null;
  };

  const res = await queryDoris<SelectReturnTypeMap[keyof SelectReturnTypeMap]>({
    query: query,
    params: {
      limit: limit,
      offset: limit && page ? limit * page : 0,
      ...(timeStampFilter
        ? {
            traceTimestamp: convertDateToAnalyticsDateTime(
              timeStampFilter.value,
            ),
          }
        : {}),
      projectId: projectId,
      ...tracesFilterRes.params,
      ...observationFilterRes.params,
      ...scoresFilterRes.params,
      ...search.params,
    },
    tags: {
      ...(props.tags ?? {}),
      feature: "tracing",
      type: "traces-table",
      projectId,
    },
  });

  // Post-process Doris results into the object shape downstream consumers expect.
  if (select === "metrics") {
    const processedRes = (res as unknown as DorisMetricsReturnType[]).map(
      (row) => {
        // Helper function to parse details fields (usage_details, cost_details)
        const parseDetails = (
          details: string | Record<string, number> | null,
        ): Record<string, number> => {
          if (!details) {
            return {};
          }

          // If already an object, return as is
          if (typeof details === "object" && !Array.isArray(details)) {
            return details;
          }

          // If it's a string (typical Doris MAP output), parse it
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
              logger.warn("Failed to parse details JSON:", {
                error,
                rawValue: trimmed.substring(0, 100),
              });
              return {};
            }
          }

          return {};
        };

        // Normalize the Array<Struct(name, avg_value)> that Doris returns.
        // The mysql driver serializes struct elements as
        // {"col1": name, "col2": avg_value}; we rename to {name, avg_value}.
        const parsedScoresAvg: Array<{ name: string; avg_value: number }> = [];

        let scoresAvgRaw: unknown[] = [];
        if (typeof row.scores_avg === "string") {
          try {
            scoresAvgRaw = JSON.parse(row.scores_avg);
          } catch {
            scoresAvgRaw = [];
          }
        } else if (Array.isArray(row.scores_avg)) {
          scoresAvgRaw = row.scores_avg;
        }

        scoresAvgRaw.forEach((entry) => {
          if (entry && typeof entry === "object") {
            const e = entry as Record<string, unknown>;
            // Doris struct fields: col1=name, col2=avg_value (positional)
            const name = e.col1 ?? e.name;
            const avg_value = e.col2 ?? e.avg_value;
            if (typeof name === "string" && name.length > 0) {
              parsedScoresAvg.push({
                name,
                avg_value: Number(avg_value) || 0,
              });
            }
          }
        });

        // Handle score_categories - could be string or array
        let scoreCategoriesArray: string[] = [];
        if (typeof row.score_categories === "string") {
          try {
            scoreCategoriesArray = JSON.parse(row.score_categories);
          } catch {
            scoreCategoriesArray = [];
          }
        } else if (Array.isArray(row.score_categories)) {
          scoreCategoriesArray = row.score_categories;
        }

        // Return row with parsed array/object values
        return {
          ...row,
          scores_avg: parsedScoresAvg,
          score_categories: scoreCategoriesArray,
          usage_details: parseDetails(row.usage_details),
          cost_details: parseDetails(row.cost_details),
        } as TracesTableMetricsDorisReturnType;
      },
    );

    return processedRes as Array<
      SelectReturnTypeMap[keyof SelectReturnTypeMap]
    >;
  }

  // Post-process Doris results for rows to ensure tags field is properly formatted as array
  if (select === "rows") {
    const processedRes = (res as unknown as TracesTableReturnType[]).map(
      (row) => {
        // Ensure tags is always an array
        let processedTags: string[] = [];

        if (Array.isArray(row.tags)) {
          processedTags = row.tags;
        } else if (typeof row.tags === "string") {
          try {
            // Try to parse as JSON array
            const parsed = JSON.parse(row.tags);
            processedTags = Array.isArray(parsed) ? parsed : [row.tags];
          } catch {
            // If parsing fails, treat as single tag
            processedTags = row.tags ? [row.tags] : [];
          }
        } else if (row.tags == null) {
          processedTags = [];
        } else {
          // Convert any other type to empty array
          processedTags = [];
        }

        return {
          ...row,
          tags: processedTags,
        } as TracesTableReturnType;
      },
    );

    return processedRes as Array<
      SelectReturnTypeMap[keyof SelectReturnTypeMap]
    >;
  }

  return res;
}

export const getTracesTableCount = async (props: {
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  searchType: TracingSearchType[];
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}) => {
  const countRows = await getTracesTableGeneric({
    select: "count",
    tags: { kind: "count" },
    ...props,
  });

  const converted = countRows.map((row) => ({
    count: Number(row.count),
  }));

  return converted.length > 0 ? converted[0].count : 0;
};

export const getTracesTableMetrics = async (props: {
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}): Promise<Array<Omit<TracesMetricsUiReturnType, "scores">>> => {
  const countRows = await getTracesTableGeneric({
    select: "metrics",
    tags: { kind: "analytic" },
    ...props,
  });

  return countRows.map(convertToUITableMetrics);
};

export const getTracesTable = async (p: {
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}) => {
  const { projectId, filter, searchQuery, searchType, orderBy, limit, page } =
    p;
  const rows = await getTracesTableGeneric({
    select: "rows",
    tags: { kind: "list" },
    projectId,
    filter,
    searchQuery,
    searchType,
    orderBy,
    limit,
    page,
  });

  return rows.map(convertToUiTableRows);
};

export const getTraceIdentifiers = async (props: {
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  searchType?: TracingSearchType[];
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}) => {
  const { projectId, filter, searchQuery, searchType, orderBy, limit, page } =
    props;
  const identifiers = await getTracesTableGeneric({
    select: "identifiers",
    tags: { kind: "list" },
    projectId,
    filter,
    searchQuery,
    searchType,
    orderBy,
    limit,
    page,
  });

  return identifiers.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    // Doris (via mysql2) returns timestamps as Date objects, but some callers
    // (e.g. legacy paths or JSON-roundtripped rows) supply ISO strings; accept
    // both. TypeScript can't narrow Date | string at runtime so we type-assert.
    timestamp:
      (row.timestamp as unknown) instanceof Date
        ? (row.timestamp as unknown as Date)
        : parseDorisUTCDateTimeFormat(row.timestamp),
  }));
};

export const getTracesTableLargeFieldStats = async (props: {
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  searchType?: TracingSearchType[];
}) => {
  const [row] = await getTracesTableGeneric({
    select: "largeFieldStats",
    tags: { kind: "analytic" },
    ...props,
  });

  return {
    avgInputBytes: Number(row?.avg_input_bytes ?? 0),
    avgOutputBytes: Number(row?.avg_output_bytes ?? 0),
    avgMetadataBytes: Number(row?.avg_metadata_bytes ?? 0),
  };
};
