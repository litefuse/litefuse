import { OrderByState } from "../../interfaces/orderBy";
import { variantMetadataSubscript } from "../utils/metadata_conversion";
import { tracesTableUiColumnDefinitionsForDoris } from "../tableMappings";
import { UiColumnMappings } from "../../tableDefinitions";
import { FilterState } from "../../types";
import { FilterList } from "../queries";

import { TraceRecordReadType } from "../repositories/definitions";
import Decimal from "decimal.js";
import { ScoreAggregate } from "../../features/scores";
import { TracingSearchType } from "../../interfaces/search";
import { ObservationLevelType, TraceDomain } from "../../domain";
// Doris imports
import {
  convertDateToAnalyticsDateTime,
  dq,
} from "../repositories/analyticsDateTime";
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
import { tableFor } from "../doris/tableRouting";

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

  // tags is a native ARRAY column on both paths, but Doris transmits ARRAY over
  // the MySQL protocol as a JSON array string (mysql2 does not auto-parse it), so
  // it can arrive as either a JS array or a JSON string. Accept both.
  const rawTags = row.tags as unknown;
  let tags: string[] = [];
  if (Array.isArray(rawTags)) {
    tags = rawTags;
  } else if (typeof rawTags === "string" && rawTags.length > 0) {
    try {
      const parsed = JSON.parse(rawTags);
      if (Array.isArray(parsed)) tags = parsed;
    } catch {
      tags = [];
    }
  }

  return {
    id: row.id,
    projectId: row.project_id,
    timestamp: timestamp,
    tags,
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
  // Trace-level rollups of the precomputed per-observation scalar columns
  // (SUM of input_tokens_calculated etc., see migration 0037). Doris may return
  // them as strings, so callers coerce with Number()/Decimal.
  total_cost: number | string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  total_tokens: number | string | null;
  input_cost: number | string | null;
  output_cost: number | string | null;
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
  return {
    id: row.id,
    projectId: row.project_id,
    latency: Number(row.latency),
    promptTokens: BigInt(Number(row.input_tokens ?? 0)),
    completionTokens: BigInt(Number(row.output_tokens ?? 0)),
    totalTokens: BigInt(Number(row.total_tokens ?? 0)),
    // The per-key usage/cost breakdown shown in the list's hover tooltip is
    // lazy-loaded per trace (getTraceUsageBreakdown) instead of being aggregated
    // here, so the list response carries only the scalar totals above.
    usageDetails: {},
    costDetails: {},
    observationCount: BigInt(row.observation_count ?? 0),
    calculatedTotalCost:
      row.total_cost != null ? new Decimal(row.total_cost) : null,
    calculatedInputCost:
      row.input_cost != null ? new Decimal(row.input_cost) : null,
    calculatedOutputCost:
      row.output_cost != null ? new Decimal(row.output_cost) : null,
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

const isTimestampFilterColumn = (column: string): boolean =>
  column === "timestamp" || column === "Timestamp";

const isIdFilterColumn = (column: string): boolean =>
  column === "id" ||
  column === "ID" ||
  column === "traceId" ||
  column === "Trace ID";

// An id filter the fast paths can EXPRESS: they all compile it to
// `id IN (...)`, which only means "any of" (stringOptions) / "=" (string).
// Any other operator (none of, contains, !=, …) must disqualify the fast path
// so the base builder applies it through the filter factory — compiling it to
// IN would silently ignore or INVERT the operator.
const isInShapedIdFilter = (f: {
  column: string;
  type: string;
  operator: string;
}): boolean =>
  isIdFilterColumn(f.column) &&
  ((f.type === "stringOptions" && f.operator === "any of") ||
    (f.type === "string" && f.operator === "="));

const isTagsFilterColumn = (column: string): boolean =>
  column === "tags" || column === "Tags";

const isMetadataFilterColumn = (column: string): boolean =>
  column === "metadata" || column === "Metadata";

// Default `select` for the latency/level having-columns below. The live
// agg⋈scalar path overrides the metric selects with the single-level sync-MV
// expressions (AGG_ROLLUP_*), so these placeholder rollup forms are not executed
// as-is; they are kept because AGG_ROLLUP_* is defined later in the file and
// cannot be forward-referenced here.
const OUTER_LATENCY =
  "milliseconds_diff(CASE WHEN MAX(start_time_max) > MAX(end_time_max) THEN MAX(start_time_max) ELSE MAX(end_time_max) END, CASE WHEN MIN(ts) < MIN(end_time_min) THEN MIN(ts) ELSE MIN(end_time_min) END) / 1000";
const OUTER_LEVEL =
  "CASE WHEN SUM(error_count) > 0 THEN 'ERROR' WHEN SUM(warning_count) > 0 THEN 'WARNING' WHEN SUM(default_count) > 0 THEN 'DEFAULT' ELSE 'DEBUG' END";

// UI column → aggregate-expression template for the metric / observation
// columns. The agg⋈scalar path derives tracesMetricAggHavingColumns from this
// (swapping in AGG_ROLLUP_* for the metric selects, targeting base spans
// columns in the sync-MV shape); mvHavingColumnTokens derives the routable
// column-token set from the identities here.
const tracesTableMvHavingColumns: UiColumnMappings = [
  // root-level scalars
  {
    uiTableName: "Environment",
    uiTableId: "environment",
    tableName: "traces",
    select: "any_value(environment)",
    queryPrefix: "",
  },
  {
    uiTableName: "User ID",
    uiTableId: "userId",
    tableName: "traces",
    select: "any_value(user_id)",
    queryPrefix: "",
  },
  {
    uiTableName: "Session ID",
    uiTableId: "sessionId",
    tableName: "traces",
    select: "any_value(session_id)",
    queryPrefix: "",
  },
  {
    uiTableName: "Version",
    uiTableId: "version",
    tableName: "traces",
    select: "any_value(version)",
    queryPrefix: "",
  },
  {
    uiTableName: "Release",
    uiTableId: "release",
    tableName: "traces",
    select: `any_value(${dq("release")})`,
    queryPrefix: "",
  },
  {
    uiTableName: "Name",
    uiTableId: "name",
    tableName: "traces",
    select: "any_value(name)",
    queryPrefix: "",
  },
  {
    uiTableName: "Trace Name",
    uiTableId: "traceName",
    tableName: "traces",
    select: "any_value(name)",
    queryPrefix: "",
  },
  {
    uiTableName: "⭐️",
    uiTableId: "bookmarked",
    tableName: "traces",
    select: "any_value(bookmarked)",
    queryPrefix: "",
  },
  // observation-level metrics (folded into the per-trace aggregate)
  {
    uiTableName: "Total Cost ($)",
    uiTableId: "totalCost",
    tableName: "observations",
    select: "SUM(total_cost)",
    queryPrefix: "",
  },
  {
    uiTableName: "Input Cost ($)",
    uiTableId: "inputCost",
    tableName: "observations",
    select: "SUM(input_cost)",
    queryPrefix: "",
  },
  {
    uiTableName: "Output Cost ($)",
    uiTableId: "outputCost",
    tableName: "observations",
    select: "SUM(output_cost)",
    queryPrefix: "",
  },
  {
    uiTableName: "Input Tokens",
    uiTableId: "inputTokens",
    tableName: "observations",
    select: "SUM(input_tokens)",
    queryPrefix: "",
  },
  {
    uiTableName: "Output Tokens",
    uiTableId: "outputTokens",
    tableName: "observations",
    select: "SUM(output_tokens)",
    queryPrefix: "",
  },
  {
    uiTableName: "Total Tokens",
    uiTableId: "totalTokens",
    tableName: "observations",
    select: "SUM(total_tokens)",
    queryPrefix: "",
  },
  {
    uiTableName: "Tokens",
    uiTableId: "tokens",
    tableName: "observations",
    select: "SUM(total_tokens)",
    queryPrefix: "",
  },
  {
    uiTableName: "Latency (s)",
    uiTableId: "latency",
    tableName: "observations",
    select: OUTER_LATENCY,
    queryPrefix: "",
  },
  {
    uiTableName: "Error Level Count",
    uiTableId: "errorCount",
    tableName: "observations",
    select: "SUM(error_count)",
    queryPrefix: "",
  },
  {
    uiTableName: "Warning Level Count",
    uiTableId: "warningCount",
    tableName: "observations",
    select: "SUM(warning_count)",
    queryPrefix: "",
  },
  {
    uiTableName: "Default Level Count",
    uiTableId: "defaultCount",
    tableName: "observations",
    select: "SUM(default_count)",
    queryPrefix: "",
  },
  {
    uiTableName: "Debug Level Count",
    uiTableId: "debugCount",
    tableName: "observations",
    select: "SUM(debug_count)",
    queryPrefix: "",
  },
  {
    uiTableName: "Level",
    uiTableId: "level",
    tableName: "observations",
    select: OUTER_LEVEL,
    queryPrefix: "",
  },
];

// Column tokens whose filters route through the agg⋈scalar / agg-metrics paths
// (the metric/observation aggregate columns above). canUseAggMetricsFastPath
// uses this to accept metric-column filters on the pre-filtered id-list path.
const mvHavingColumnTokens = new Set(
  tracesTableMvHavingColumns.flatMap((c) => [c.uiTableName, c.uiTableId]),
);

// --- traces_scalar flat fast path (rows / count) ---------------------------
// traces_scalar (migration 0039) holds ONE row per trace — the root span's
// scalar fields, written by the OTel-lane job. Every column the list returns is in
// it, so when all filters are scalar-routable the rows/count queries run as a
// FLAT single-table scan: no GROUP BY, no aggregate rollup, and inverted indexes
// on user_id/session_id/name/tags/environment serve the filters directly. Metric
// filters (cost/tokens/latency/level) are all-span aggregates the scalar table
// cannot answer — those lists fall through to the agg⋈scalar path (or the base
// builder); metrics queries use the agg-metrics path.

// UI column → direct traces_scalar column, for routing scalar filters into the
// flat WHERE. name serves both Name and Trace Name (the table stores the
// explicit trace_name). Values were normalized at write time (empty string →
// NULL) to match the MV's NULLIF(x, '') semantics, so operators behave
// identically on both paths.
const tracesScalarFilterColumns: UiColumnMappings = [
  {
    uiTableName: "Environment",
    uiTableId: "environment",
    tableName: "traces",
    select: "environment",
    queryPrefix: "",
  },
  {
    uiTableName: "User ID",
    uiTableId: "userId",
    tableName: "traces",
    select: "user_id",
    queryPrefix: "",
  },
  {
    uiTableName: "Session ID",
    uiTableId: "sessionId",
    tableName: "traces",
    select: "session_id",
    queryPrefix: "",
  },
  {
    uiTableName: "Version",
    uiTableId: "version",
    tableName: "traces",
    select: "version",
    queryPrefix: "",
  },
  {
    uiTableName: "Release",
    uiTableId: "release",
    tableName: "traces",
    select: dq("release"),
    queryPrefix: "",
  },
  {
    uiTableName: "Name",
    uiTableId: "name",
    tableName: "traces",
    select: "name",
    queryPrefix: "",
  },
  {
    uiTableName: "Trace Name",
    uiTableId: "traceName",
    tableName: "traces",
    select: "name",
    queryPrefix: "",
  },
  {
    uiTableName: "⭐️",
    uiTableId: "bookmarked",
    tableName: "traces",
    select: "bookmarked",
    queryPrefix: "",
  },
];

const scalarFilterColumnTokens = new Set(
  tracesScalarFilterColumns.flatMap((c) => [c.uiTableName, c.uiTableId]),
);

// Eligibility restricted to what the scalar table can answer: timestamp range,
// trace-id list, tags, per-key metadata, scalar column filters, ID search,
// timestamp ordering. Metric column filters (mvHavingColumnTokens minus these)
// disqualify — the agg⋈scalar path handles them.
const canUseScalarListFastPath = (params: {
  filter: FilterState;
  orderBy?: OrderByState;
  searchQuery?: string;
  searchType?: TracingSearchType[];
}): boolean => {
  const { filter, orderBy, searchQuery, searchType } = params;
  if (searchQuery && (!searchType || searchType.some((t) => t !== "id")))
    return false;
  if (orderBy && orderBy.column !== "timestamp") return false;
  return filter.every(
    (f) =>
      (f.type === "datetime" && isTimestampFilterColumn(f.column)) ||
      isInShapedIdFilter(f) ||
      (f.type === "arrayOptions" && isTagsFilterColumn(f.column)) ||
      (f.type === "stringObject" && isMetadataFilterColumn(f.column)) ||
      scalarFilterColumnTokens.has(f.column),
  );
};

// Flat WHERE over traces_scalar — one row per trace means every filter that is
// a HAVING on the aggregate rollup becomes a plain WHERE on a column here.
const buildScalarListWhere = (
  filter: FilterState,
  searchQuery?: string,
): { whereParts: string[]; params: Record<string, unknown> } => {
  const whereParts: string[] = ["project_id = {projectId: String}"];
  const params: Record<string, unknown> = {};

  const tsFilters = filter.filter((f) => f.type === "datetime");
  const fromFilter = tsFilters.find(
    (f) => f.operator === ">=" || f.operator === ">",
  );
  const toFilter = tsFilters.find(
    (f) => f.operator === "<=" || f.operator === "<",
  );
  if (fromFilter) {
    params.fromTs = convertDateToAnalyticsDateTime(fromFilter.value as Date);
    // Day-truncated bound first (prunes partitions natively — AUTO PARTITION on
    // start_time), then the precise bound.
    whereParts.push("DATE(start_time) >= DATE({fromTs: DateTime})");
    whereParts.push(`start_time ${fromFilter.operator} {fromTs: DateTime}`);
  }
  if (toFilter) {
    params.toTs = convertDateToAnalyticsDateTime(toFilter.value as Date);
    whereParts.push("DATE(start_time) <= DATE({toTs: DateTime})");
    whereParts.push(`start_time ${toFilter.operator} {toTs: DateTime}`);
  }

  const idFilter = filter.find(isInShapedIdFilter);
  if (idFilter) {
    const ids =
      idFilter.type === "stringOptions"
        ? (idFilter.value as string[])
        : [idFilter.value as string];
    params.traceIds = ids;
    whereParts.push("id IN ({traceIds: Array(String)})");
  }

  // tags: native ARRAY column; exact membership via array_contains (same
  // operator handling as the aggregate paths, minus the rollup).
  for (const f of filter) {
    if (f.type !== "arrayOptions" || !isTagsFilterColumn(f.column)) continue;
    const contains = (f.value as string[]).map((v) => {
      const escaped = v.replace(/'/g, "''");
      return `array_contains(tags, '${escaped}')`;
    });
    if (contains.length === 0) continue;
    if (f.operator === "all of") whereParts.push(`(${contains.join(" AND ")})`);
    else if (f.operator === "none of")
      whereParts.push(`NOT (${contains.join(" OR ")})`);
    else whereParts.push(`(${contains.join(" OR ")})`); // "any of"
  }

  // metadata: per-key lookup on the native map column (mirrors the base
  // StringObjectFilter operators on map['key']).
  for (const f of filter) {
    if (f.type !== "stringObject" || !isMetadataFilterColumn(f.column))
      continue;
    // VARIANT nested subscript (dotted key → nested path), CAST to STRING.
    const lookup = `CAST(metadata${variantMetadataSubscript(f.key)} AS STRING)`;
    const escapedValue = f.value.replace(/'/g, "''");
    switch (f.operator) {
      case "=":
        whereParts.push(`${lookup} = '${escapedValue}'`);
        break;
      case "contains":
        whereParts.push(`INSTR(${lookup}, '${escapedValue}') > 0`);
        break;
      case "does not contain":
        whereParts.push(`INSTR(${lookup}, '${escapedValue}') = 0`);
        break;
      case "starts with":
        whereParts.push(`STARTS_WITH(${lookup}, '${escapedValue}')`);
        break;
      case "ends with":
        whereParts.push(`ENDS_WITH(${lookup}, '${escapedValue}')`);
        break;
    }
  }

  // scalar column filters → direct column predicates. The Doris filter classes
  // emit inline-escaped values (no bind params), so the SQL is self-contained.
  const scalarColumnFilters = filter.filter((f) =>
    scalarFilterColumnTokens.has(f.column),
  );
  if (scalarColumnFilters.length > 0) {
    const res = new FilterList(
      createDorisFilterFromFilterState(
        scalarColumnFilters,
        tracesScalarFilterColumns,
      ),
    ).apply();
    if (res.query) whereParts.push(res.query);
  }

  // ID search (searchType ["id"]): trace id + root user_id / name, OR-ed.
  if (searchQuery) {
    params.searchLike = `%${searchQuery}%`;
    whereParts.push(
      `(id LIKE {searchLike: String}` +
        ` OR user_id LIKE {searchLike: String}` +
        ` OR name LIKE {searchLike: String})`,
    );
  }

  return { whereParts, params };
};

const runScalarRowsFastPath = async (params: {
  projectId: string;
  filter: FilterState;
  orderByDesc: boolean;
  searchQuery?: string;
  limit?: number;
  page?: number;
  tags?: Record<string, string>;
}): Promise<TracesTableReturnType[]> => {
  const { projectId, filter, orderByDesc, limit, page, tags, searchQuery } =
    params;

  const { whereParts, params: filterParams } = buildScalarListWhere(
    filter,
    searchQuery,
  );
  const queryParams: Record<string, unknown> = { projectId, ...filterParams };

  const order = orderByDesc ? "DESC" : "ASC";
  const pagination =
    limit !== undefined && page !== undefined
      ? "LIMIT {limit: Int32} OFFSET {offset: Int32}"
      : "";
  if (pagination) {
    queryParams.limit = limit;
    queryParams.offset = (limit ?? 0) * (page ?? 0);
  }

  // Flat scan: one row per trace already, so the sort leads with the day-
  // truncated timestamp (partition-ordered) then the precise timestamp — the
  // same ordering shape as the agg paths' DATE(MIN(start_time)), MIN(start_time).
  const query = `
    SELECT
      id,
      project_id,
      start_time AS ${dq("timestamp")},
      tags,
      bookmarked,
      name,
      ${dq("release")},
      version,
      user_id,
      environment,
      session_id,
      ${dq("public")}
    FROM ${tableFor(projectId, "traces_scalar")}
    WHERE ${whereParts.join(" AND ")}
    ORDER BY DATE(start_time) ${order}, start_time ${order}, created_at DESC
    ${pagination}
  `;

  return await queryDoris<TracesTableReturnType>({
    query,
    params: queryParams,
    tags: {
      ...(tags ?? {}),
      feature: "tracing",
      type: "traces-table",
      projectId,
    },
  });
};

// Identifiers fast path: id/projectId/timestamp are all on traces_scalar, so
// scalar-routable filters serve select:"identifiers" as the same flat scan as
// the rows path with a three-column projection — previously identifiers ALWAYS
// fell through to the base spans builder (no fast path handled it).
const runScalarIdentifiersFastPath = async (params: {
  projectId: string;
  filter: FilterState;
  orderByDesc: boolean;
  searchQuery?: string;
  limit?: number;
  page?: number;
  tags?: Record<string, string>;
}): Promise<Array<{ id: string; projectId: string; timestamp: string }>> => {
  const { projectId, filter, orderByDesc, limit, page, tags, searchQuery } =
    params;

  const { whereParts, params: filterParams } = buildScalarListWhere(
    filter,
    searchQuery,
  );
  const queryParams: Record<string, unknown> = { projectId, ...filterParams };

  const order = orderByDesc ? "DESC" : "ASC";
  const pagination =
    limit !== undefined && page !== undefined
      ? "LIMIT {limit: Int32} OFFSET {offset: Int32}"
      : "";
  if (pagination) {
    queryParams.limit = limit;
    queryParams.offset = (limit ?? 0) * (page ?? 0);
  }

  const query = `
    SELECT
      id,
      project_id AS projectId,
      start_time AS ${dq("timestamp")}
    FROM ${tableFor(projectId, "traces_scalar")}
    WHERE ${whereParts.join(" AND ")}
    ORDER BY DATE(start_time) ${order}, start_time ${order}, created_at DESC
    ${pagination}
  `;

  return await queryDoris<{ id: string; projectId: string; timestamp: string }>(
    {
      query,
      params: queryParams,
      tags: {
        ...(tags ?? {}),
        feature: "tracing",
        type: "traces-table-identifiers",
        projectId,
      },
    },
  );
};

const runScalarCountFastPath = async (params: {
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  tags?: Record<string, string>;
}): Promise<Array<{ count: string }>> => {
  const { projectId, filter, tags, searchQuery } = params;

  const { whereParts, params: filterParams } = buildScalarListWhere(
    filter,
    searchQuery,
  );
  const queryParams: Record<string, unknown> = { projectId, ...filterParams };

  // One row per trace → count(*) needs no dedup/grouping.
  const query = `
    SELECT count(*) AS count
    FROM ${tableFor(projectId, "traces_scalar")}
    WHERE ${whereParts.join(" AND ")}
  `;

  return await queryDoris<{ count: string }>({
    query,
    params: queryParams,
    tags: {
      ...(tags ?? {}),
      feature: "tracing",
      type: "traces-table-count",
      projectId,
    },
  });
};

// --- metric-filtered / metric-sorted list fast path (agg ⋈ scalar) ---------
// Lists that filter or sort by observation-level metrics (latency, cost,
// tokens, level counts) would otherwise fall to the base builder (spans
// self-aggregate + JOINs) — exactly the billions-of-spans scans this table set
// exists to avoid. This path answers them from the rollup only:
//   inner  m: spans GROUP BY trace_id with aggregate expressions that
//             structurally match the trace_metrics_agg SYNC MV (migration
//             0040) — Doris transparently rewrites the scan onto the rollup
//             (a handful of per-day rows per trace), with the metric filters
//             as HAVING and the metric aliases projected for ORDER BY;
//   outer  s: JOIN ${tableFor(projectId, "traces_scalar")} for display columns + scalar filters,
//             ORDER BY metric alias or timestamp, LIMIT/OFFSET.
// A trace missing from either side drops out via the inner join — the same
// outcome a metric HAVING produces (no metrics → filtered out).
//
// IMPORTANT: every aggregate below must stay expression-identical to the sync
// MV definition in migration 0040 (SUM/MIN/MAX over the same base columns,
// SUM(CASE WHEN level = '…' THEN 1 ELSE 0 END) for level counts, and
// date_trunc(start_time, 'day') for day bounds) — that structural match is
// what keeps the transparent rewrite firing instead of scanning base rows.

// Latency over the sync-MV aggregates — mirrors OUTER_LATENCY over the base
// column MIN/MAX (each MIN/MAX(start_time/end_time) is an MV column).
const AGG_ROLLUP_LATENCY =
  "milliseconds_diff(CASE WHEN MAX(start_time) > MAX(end_time) THEN MAX(start_time) ELSE MAX(end_time) END, CASE WHEN MIN(start_time) < MIN(end_time) THEN MIN(start_time) ELSE MIN(end_time) END) / 1000";

// Level-count SUMs in the sync-MV shape (must match migration 0040 verbatim).
const AGG_ROLLUP_LEVEL_COUNTS: Record<string, string> = {
  errorCount: "SUM(CASE WHEN level = 'ERROR'   THEN 1 ELSE 0 END)",
  warningCount: "SUM(CASE WHEN level = 'WARNING' THEN 1 ELSE 0 END)",
  defaultCount: "SUM(CASE WHEN level = 'DEFAULT' THEN 1 ELSE 0 END)",
  debugCount: "SUM(CASE WHEN level = 'DEBUG'   THEN 1 ELSE 0 END)",
};
const AGG_ROLLUP_LEVEL = `CASE WHEN ${AGG_ROLLUP_LEVEL_COUNTS.errorCount} > 0 THEN 'ERROR' WHEN ${AGG_ROLLUP_LEVEL_COUNTS.warningCount} > 0 THEN 'WARNING' WHEN ${AGG_ROLLUP_LEVEL_COUNTS.defaultCount} > 0 THEN 'DEFAULT' ELSE 'DEBUG' END`;

// Metric filter → HAVING expression over the single-level spans
// aggregate. The MV having map's selects reference per-day CTE aliases
// (input_tokens, error_count, …); over spans they must target the base
// columns / level CASEs in the sync-MV shape instead.
const AGG_ROLLUP_METRIC_EXPRS: Record<string, string> = {
  totalCost: "SUM(total_cost)",
  inputCost: "SUM(input_cost_calculated)",
  outputCost: "SUM(output_cost_calculated)",
  inputTokens: "SUM(input_tokens_calculated)",
  outputTokens: "SUM(output_tokens_calculated)",
  totalTokens: "SUM(total_tokens_calculated)",
  tokens: "SUM(total_tokens_calculated)",
  latency: AGG_ROLLUP_LATENCY,
  level: AGG_ROLLUP_LEVEL,
  ...AGG_ROLLUP_LEVEL_COUNTS,
};

const tracesMetricAggHavingColumns: UiColumnMappings =
  tracesTableMvHavingColumns
    .filter((c) => c.tableName === "observations")
    .map((c) => ({
      ...c,
      select: AGG_ROLLUP_METRIC_EXPRS[c.uiTableId] ?? c.select,
    }));

const metricAggColumnTokens = new Set(
  tracesMetricAggHavingColumns.flatMap((c) => [c.uiTableName, c.uiTableId]),
);

// Sortable metric columns → the inner subquery's projected alias. `level` is
// deliberately absent (a CASE string; severity ordering isn't alphabetical) —
// sorting by it stays on the base builder.
const METRIC_ORDER_EXPRS: Record<string, string> = {
  latency: "m.latency",
  totalCost: "m.total_cost",
  inputCost: "m.input_cost",
  outputCost: "m.output_cost",
  totalTokens: "m.total_tokens",
  tokens: "m.total_tokens",
  inputTokens: "m.input_tokens",
  outputTokens: "m.output_tokens",
  errorCount: "m.error_count",
  warningCount: "m.warning_count",
  defaultCount: "m.default_count",
  debugCount: "m.debug_count",
};

// Eligible when a metric is actually involved (filter or ORDER BY — otherwise
// the flat scalar path owns the query) and every other filter is one the
// scalar side can serve. Content search needs spans's FTS index → out.
const canUseMetricListFastPath = (params: {
  filter: FilterState;
  orderBy?: OrderByState;
  searchQuery?: string;
  searchType?: TracingSearchType[];
}): boolean => {
  const { filter, orderBy, searchQuery, searchType } = params;
  if (searchQuery && (!searchType || searchType.some((t) => t !== "id")))
    return false;
  const metricOrder =
    orderBy && orderBy.column !== "timestamp"
      ? METRIC_ORDER_EXPRS[orderBy.column]
      : undefined;
  if (orderBy && orderBy.column !== "timestamp" && !metricOrder) return false;
  const hasMetricFilter = filter.some((f) =>
    metricAggColumnTokens.has(f.column),
  );
  if (!hasMetricFilter && !metricOrder) return false;
  return filter.every(
    (f) =>
      (f.type === "datetime" && isTimestampFilterColumn(f.column)) ||
      isInShapedIdFilter(f) ||
      (f.type === "arrayOptions" && isTagsFilterColumn(f.column)) ||
      (f.type === "stringObject" && isMetadataFilterColumn(f.column)) ||
      scalarFilterColumnTokens.has(f.column) ||
      metricAggColumnTokens.has(f.column),
  );
};

const buildMetricListQuery = (params: {
  projectId: string;
  select: "rows" | "count";
  filter: FilterState;
  orderBy?: OrderByState;
  searchQuery?: string;
  withPagination: boolean;
}): { query: string; timeParams: Record<string, unknown> } => {
  const { projectId, select, filter, orderBy, searchQuery, withPagination } =
    params;

  // Scalar-side WHERE (bare column names resolve to s — the inner subquery
  // only projects trace_id + metric aliases, so nothing is ambiguous).
  const { whereParts } = buildScalarListWhere(
    filter.filter((f) => !metricAggColumnTokens.has(f.column)),
    searchQuery,
  );

  // Inner agg WHERE: project + the same date bounds (same {fromTs}/{toTs}
  // placeholders — parameter substitution is by name, reuse is free). Day
  // bounds use date_trunc(start_time, 'day') — the sync MV's key expression —
  // so the predicate stays answerable by the rollup.
  const tsFilters = filter.filter((f) => f.type === "datetime");
  const fromFilter = tsFilters.find(
    (f) => f.operator === ">=" || f.operator === ">",
  );
  const toFilter = tsFilters.find(
    (f) => f.operator === "<=" || f.operator === "<",
  );
  const timeParams: Record<string, unknown> = {};
  const innerWhere = ["project_id = {projectId: String}"];
  if (fromFilter) {
    timeParams.fromTs = convertDateToAnalyticsDateTime(
      fromFilter.value as Date,
    );
    innerWhere.push(
      "date_trunc(start_time, 'day') >= date_trunc({fromTs: DateTime}, 'day')",
    );
  }
  if (toFilter) {
    timeParams.toTs = convertDateToAnalyticsDateTime(toFilter.value as Date);
    innerWhere.push(
      "date_trunc(start_time, 'day') <= date_trunc({toTs: DateTime}, 'day')",
    );
  }

  // Metric filters → HAVING over the rollup (inline-escaped, self-contained).
  const metricFilters = filter.filter((f) =>
    metricAggColumnTokens.has(f.column),
  );
  const havingRes =
    metricFilters.length > 0
      ? new FilterList(
          createDorisFilterFromFilterState(
            metricFilters,
            tracesMetricAggHavingColumns,
          ),
        ).apply()
      : undefined;

  const inner = `
      SELECT
        trace_id,
        ${AGG_ROLLUP_LATENCY} AS latency,
        ${AGG_ROLLUP_METRIC_EXPRS.totalCost} AS total_cost,
        ${AGG_ROLLUP_METRIC_EXPRS.inputCost} AS input_cost,
        ${AGG_ROLLUP_METRIC_EXPRS.outputCost} AS output_cost,
        ${AGG_ROLLUP_METRIC_EXPRS.inputTokens} AS input_tokens,
        ${AGG_ROLLUP_METRIC_EXPRS.outputTokens} AS output_tokens,
        ${AGG_ROLLUP_METRIC_EXPRS.totalTokens} AS total_tokens,
        ${AGG_ROLLUP_LEVEL_COUNTS.errorCount} AS error_count,
        ${AGG_ROLLUP_LEVEL_COUNTS.warningCount} AS warning_count,
        ${AGG_ROLLUP_LEVEL_COUNTS.defaultCount} AS default_count,
        ${AGG_ROLLUP_LEVEL_COUNTS.debugCount} AS debug_count
      FROM ${tableFor(projectId, "spans")}
      WHERE ${innerWhere.join(" AND ")}
      GROUP BY trace_id
      ${havingRes?.query ? `HAVING ${havingRes.query}` : ""}`;

  if (select === "count") {
    return {
      query: `
    SELECT count(*) AS count
    FROM ${tableFor(projectId, "traces_scalar")} s
    JOIN (${inner}
    ) m ON m.trace_id = s.id
    WHERE ${whereParts.join(" AND ")}
  `,
      timeParams,
    };
  }

  const metricOrder =
    orderBy && orderBy.column !== "timestamp"
      ? METRIC_ORDER_EXPRS[orderBy.column]
      : undefined;
  const dir = orderBy?.order === "ASC" ? "ASC" : "DESC";
  const orderSql = metricOrder
    ? `ORDER BY ${metricOrder} ${dir}, s.start_time DESC`
    : `ORDER BY DATE(s.start_time) ${dir}, s.start_time ${dir}, s.created_at DESC`;

  return {
    query: `
    SELECT
      s.id,
      s.project_id,
      s.start_time AS ${dq("timestamp")},
      s.tags,
      s.bookmarked,
      s.name,
      s.${dq("release")},
      s.version,
      s.user_id,
      s.environment,
      s.session_id,
      s.${dq("public")}
    FROM ${tableFor(projectId, "traces_scalar")} s
    JOIN (${inner}
    ) m ON m.trace_id = s.id
    WHERE ${whereParts.join(" AND ")}
    ${orderSql}
    ${withPagination ? "LIMIT {limit: Int32} OFFSET {offset: Int32}" : ""}
  `,
    timeParams,
  };
};

const runMetricListRowsFastPath = async (params: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  searchQuery?: string;
  limit?: number;
  page?: number;
  tags?: Record<string, string>;
}): Promise<TracesTableReturnType[]> => {
  const { projectId, filter, orderBy, limit, page, tags, searchQuery } = params;
  const { params: scalarParams } = buildScalarListWhere(
    filter.filter((f) => !metricAggColumnTokens.has(f.column)),
    searchQuery,
  );
  const withPagination = limit !== undefined && page !== undefined;
  const { query, timeParams } = buildMetricListQuery({
    projectId,
    select: "rows",
    filter,
    orderBy,
    searchQuery,
    withPagination,
  });
  const queryParams: Record<string, unknown> = {
    projectId,
    ...scalarParams,
    ...timeParams,
    ...(withPagination ? { limit, offset: (limit ?? 0) * (page ?? 0) } : {}),
  };
  return await queryDoris<TracesTableReturnType>({
    query,
    params: queryParams,
    tags: {
      ...(tags ?? {}),
      feature: "tracing",
      type: "traces-table-metric-list",
      projectId,
    },
  });
};

const runMetricListCountFastPath = async (params: {
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  tags?: Record<string, string>;
}): Promise<Array<{ count: string }>> => {
  const { projectId, filter, tags, searchQuery } = params;
  const { params: scalarParams } = buildScalarListWhere(
    filter.filter((f) => !metricAggColumnTokens.has(f.column)),
    searchQuery,
  );
  const { query, timeParams } = buildMetricListQuery({
    projectId,
    select: "count",
    filter,
    searchQuery,
    withPagination: false,
  });
  return await queryDoris<{ count: string }>({
    query,
    params: { projectId, ...scalarParams, ...timeParams },
    tags: {
      ...(tags ?? {}),
      feature: "tracing",
      type: "traces-table-metric-list-count",
      projectId,
    },
  });
};

// A filter is agg-routable when it maps to the aggregate: the timestamp
// range (partition prune + MIN(start_time)), a trace_id list, tags (array_contains
// on the rolled-up native array), per-key metadata (element_at over the rolled-up
// parallel arrays), or any scalar/metric column with an aggregate expression
// (HAVING). NOT routable: scores (separate table) or content search — those fall
// back to the base builder.
// --- trace_metrics_agg metrics fast path -----------------------------------
// trace_metrics_agg (migration 0040) is a SYNCHRONOUS materialized view on
// spans: one rollup row per (project, trace, day), maintained
// atomically by every load transaction — CURRENT for the live partition, no
// staleness compensation. The query below aggregates spans in the sync
// MV's exact expression shape so Doris transparently rewrites it onto the
// rollup (then only rolls the per-day rows up to one row per trace —
// SUM-of-SUM / MIN-of-MIN / MAX-of-MAX, a handful of rows per trace).
//
// Eligibility: an explicit trace-id list must be present. traces.metrics (the
// only caller) always sends the page's ids, which traces.all ALREADY produced
// under the full filter set — so every non-time filter is redundant here and
// deliberately NOT re-applied (the router already prunes score filters on the
// same reasoning). Unknown filter columns still disqualify, so a future
// caller without pre-filtered ids falls back to the base builder instead of
// silently losing its filters.
const canUseAggMetricsFastPath = (params: {
  filter: FilterState;
  orderBy?: OrderByState;
  searchQuery?: string;
}): boolean => {
  const { filter, orderBy, searchQuery } = params;
  if (searchQuery) return false;
  if (orderBy && orderBy.column !== "timestamp") return false;
  const hasIdFilter = filter.some(isInShapedIdFilter);
  if (!hasIdFilter) return false;
  // Every filter must be one traces.all could have applied when producing the
  // id list (time/id/tags/metadata/scalar/metric columns).
  return filter.every(
    (f) =>
      (f.type === "datetime" && isTimestampFilterColumn(f.column)) ||
      isInShapedIdFilter(f) ||
      (f.type === "arrayOptions" && isTagsFilterColumn(f.column)) ||
      (f.type === "stringObject" && isMetadataFilterColumn(f.column)) ||
      scalarFilterColumnTokens.has(f.column) ||
      mvHavingColumnTokens.has(f.column),
  );
};

const runAggMetricsFastPath = async (params: {
  projectId: string;
  filter: FilterState;
  orderByDesc: boolean;
  limit?: number;
  page?: number;
  tags?: Record<string, string>;
}): Promise<TracesTableMetricsDorisReturnType[]> => {
  const { projectId, filter, orderByDesc, limit, page, tags } = params;

  const whereParts: string[] = ["project_id = {projectId: String}"];
  const havingParts: string[] = [];
  const queryParams: Record<string, unknown> = { projectId };

  const tsFilters = filter.filter((f) => f.type === "datetime");
  const fromFilter = tsFilters.find(
    (f) => f.operator === ">=" || f.operator === ">",
  );
  const toFilter = tsFilters.find(
    (f) => f.operator === "<=" || f.operator === "<",
  );
  if (fromFilter) {
    queryParams.fromTs = convertDateToAnalyticsDateTime(
      fromFilter.value as Date,
    );
    whereParts.push(
      "date_trunc(start_time, 'day') >= date_trunc({fromTs: DateTime}, 'day')",
    );
    havingParts.push(
      `MIN(start_time) ${fromFilter.operator} {fromTs: DateTime}`,
    );
  }
  if (toFilter) {
    queryParams.toTs = convertDateToAnalyticsDateTime(toFilter.value as Date);
    whereParts.push(
      "date_trunc(start_time, 'day') <= date_trunc({toTs: DateTime}, 'day')",
    );
    havingParts.push(`MIN(start_time) ${toFilter.operator} {toTs: DateTime}`);
  }

  const idFilter = filter.find(isInShapedIdFilter);
  if (idFilter) {
    queryParams.traceIds =
      idFilter.type === "stringOptions"
        ? (idFilter.value as string[])
        : [idFilter.value as string];
    whereParts.push("trace_id IN ({traceIds: Array(String)})");
  }

  const order = orderByDesc ? "DESC" : "ASC";
  const pagination =
    limit !== undefined && page !== undefined
      ? "LIMIT {limit: Int32} OFFSET {offset: Int32}"
      : "";
  if (pagination) {
    queryParams.limit = limit;
    queryParams.offset = (limit ?? 0) * (page ?? 0);
  }

  // Latency/level formulas mirror OUTER_LATENCY/OUTER_LEVEL in the sync-MV
  // expression shape (identical NULL behavior: an all-open trace yields NULL
  // latency). Every aggregate matches migration 0040 verbatim so the scan
  // transparently rewrites onto the trace_metrics_agg rollup. The rollup counts
  // non-root spans; + 1 adds the trace's root span, which is an observation too.
  const query = `
    SELECT
      trace_id AS id,
      project_id,
      MIN(start_time) AS ${dq("timestamp")},
      ${AGG_ROLLUP_LATENCY} AS latency,
      ${AGG_ROLLUP_METRIC_EXPRS.totalCost} AS total_cost,
      ${AGG_ROLLUP_METRIC_EXPRS.inputTokens} AS input_tokens,
      ${AGG_ROLLUP_METRIC_EXPRS.outputTokens} AS output_tokens,
      ${AGG_ROLLUP_METRIC_EXPRS.totalTokens} AS total_tokens,
      ${AGG_ROLLUP_METRIC_EXPRS.inputCost} AS input_cost,
      ${AGG_ROLLUP_METRIC_EXPRS.outputCost} AS output_cost,
      ${AGG_ROLLUP_LEVEL} AS level,
      ${AGG_ROLLUP_LEVEL_COUNTS.errorCount} AS error_count,
      ${AGG_ROLLUP_LEVEL_COUNTS.warningCount} AS warning_count,
      ${AGG_ROLLUP_LEVEL_COUNTS.defaultCount} AS default_count,
      ${AGG_ROLLUP_LEVEL_COUNTS.debugCount} AS debug_count,
      SUM(CASE WHEN is_root = 0       THEN 1 ELSE 0 END) + 1 AS observation_count
    FROM ${tableFor(projectId, "spans")}
    WHERE ${whereParts.join(" AND ")}
    GROUP BY project_id, trace_id
    ${havingParts.length > 0 ? `HAVING ${havingParts.join(" AND ")}` : ""}
    ORDER BY DATE(MIN(start_time)) ${order}, MIN(start_time) ${order}, MAX(created_at) DESC
    ${pagination}
  `;

  return await queryDoris<TracesTableMetricsDorisReturnType>({
    query,
    params: queryParams,
    tags: {
      ...(tags ?? {}),
      feature: "tracing",
      type: "traces-table-metrics-agg",
      projectId,
    },
  });
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

  const orderByDesc =
    orderBy?.column === "timestamp" ? orderBy.order !== "ASC" : true;

  // Metric-filtered / metric-sorted lists (rows/count): agg ⋈ scalar join —
  // the realtime rollup answers the metric side, traces_scalar the display
  // side. Without this these queries fall to the base builder (spans
  // self-aggregate + JOINs).
  const metricListEligible =
    (select === "rows" || select === "count") &&
    canUseMetricListFastPath({ filter, orderBy, searchQuery, searchType });

  if (select === "rows" && metricListEligible) {
    return (await runMetricListRowsFastPath({
      projectId,
      filter,
      orderBy,
      limit,
      page,
      tags: props.tags,
      searchQuery,
    })) as Array<SelectReturnTypeMap[keyof SelectReturnTypeMap]>;
  }

  if (select === "count" && metricListEligible) {
    return (await runMetricListCountFastPath({
      projectId,
      filter,
      tags: props.tags,
      searchQuery,
    })) as Array<SelectReturnTypeMap[keyof SelectReturnTypeMap]>;
  }

  // Flat traces_scalar path first (rows/count/identifiers): the list's columns
  // are all root-pick scalars written one-row-per-trace by the lane, so scalar-routable
  // filters skip aggregation entirely. Metric-filtered lists take the agg⋈scalar
  // path above; metrics queries use the agg-metrics path (all-span aggregates).
  const scalarEligible =
    (select === "rows" || select === "count" || select === "identifiers") &&
    canUseScalarListFastPath({ filter, orderBy, searchQuery, searchType });

  if (select === "identifiers" && scalarEligible) {
    return (await runScalarIdentifiersFastPath({
      projectId,
      filter,
      orderByDesc,
      limit,
      page,
      tags: props.tags,
      searchQuery,
    })) as Array<SelectReturnTypeMap[keyof SelectReturnTypeMap]>;
  }

  if (select === "rows" && scalarEligible) {
    return (await runScalarRowsFastPath({
      projectId,
      filter,
      orderByDesc,
      limit,
      page,
      tags: props.tags,
      searchQuery,
    })) as Array<SelectReturnTypeMap[keyof SelectReturnTypeMap]>;
  }

  if (select === "count" && scalarEligible) {
    return (await runScalarCountFastPath({
      projectId,
      filter,
      tags: props.tags,
      searchQuery,
    })) as Array<SelectReturnTypeMap[keyof SelectReturnTypeMap]>;
  }

  // Realtime agg rollup first (id-scoped metrics — the traces.metrics page
  // call): current on the live partition, no async-MV staleness. Falls to the
  // base builder when no id list is present or a filter isn't id-list-derived.
  if (
    select === "metrics" &&
    canUseAggMetricsFastPath({ filter, orderBy, searchQuery })
  ) {
    return (await runAggMetricsFastPath({
      projectId,
      filter,
      orderByDesc,
      limit,
      page,
      tags: props.tags,
    })) as Array<SelectReturnTypeMap[keyof SelectReturnTypeMap]>;
  }

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
        os.total_cost as total_cost,
        os.input_tokens as input_tokens,
        os.output_tokens as output_tokens,
        os.total_tokens as total_tokens,
        os.input_cost as input_cost,
        os.output_cost as output_cost,
        os.aggregated_level as level,
        os.error_count as error_count,
        os.warning_count as warning_count,
        os.default_count as default_count,
        os.debug_count as debug_count,
        -- observations_stats counts non-root spans; + 1 adds the root span.
        COALESCE(os.observation_count, 0) + 1 as observation_count,
        -- scores for the list are fetched separately (getScoresForTraces) and
        -- merged by trace_id in the tRPC layer; convertToUITableMetrics discards
        -- these, so emit NULL instead of computing a dead scores_avg aggregate.
        -- The scores_avg CTE/JOIN is built ONLY when filtering/ordering by score
        -- (requiresScoresJoin), where it feeds the WHERE/ORDER, not this SELECT.
        NULL as scores_avg,
        NULL as score_categories,
        t.${dq("public")} as ${dq("public")}`;
      break;
    case "rows":
      // `t` is `spans` filtered to the root span (parent_span_id =
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
          COALESCE(CHAR_LENGTH(json_object_flatten(t.metadata)), 0)
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
      select: "t.created_at",
      uiTableName: "created_at",
      uiTableId: "created_at",
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
            { column: "created_at", order: "DESC" as "DESC" },
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
        -- Trace-level rollup of its observations: a single-table aggregate over
        -- spans (no parent_span_id predicate, level via SUM(CASE) counts,
        -- latency from raw min/max components, partition prune on start_time).
        -- Aggregates are all-spans:
        -- the synthetic root span carries no cost/tokens, so those totals are
        -- unchanged; latency becomes the full-trace span and level counts include
        -- the root span. observation_count stays children-only via SUM(IF(...)).
        -- An observation-level filter (rare) adds a non-grouping predicate that
        -- the rewrite can't compensate, so such queries fall back to base — still
        -- correct, just not rollup-accelerated.
        SELECT
          trace_id,
          project_id,
          SUM(IF(is_root = 0, 1, 0)) AS observation_count,
          SUM(total_cost) AS total_cost,
          SUM(input_tokens_calculated) AS input_tokens,
          SUM(output_tokens_calculated) AS output_tokens,
          SUM(total_tokens_calculated) AS total_tokens,
          SUM(input_cost_calculated) AS input_cost,
          SUM(output_cost_calculated) AS output_cost,
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
          -- Level priority derived from the counts above (collect_list does not
          -- transparently rewrite; CASE over SUM(CASE) does).
          CASE
            WHEN sum(CASE WHEN level = 'ERROR' THEN 1 ELSE 0 END) > 0 THEN 'ERROR'
            WHEN sum(CASE WHEN level = 'WARNING' THEN 1 ELSE 0 END) > 0 THEN 'WARNING'
            WHEN sum(CASE WHEN level = 'DEFAULT' THEN 1 ELSE 0 END) > 0 THEN 'DEFAULT'
            ELSE 'DEBUG'
          END AS aggregated_level
        FROM ${tableFor(projectId, "spans")} o
        WHERE project_id = {projectId: String}
        ${timeStampFilter ? `AND start_time >= DATE(DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY))` : ""}
        ${observationFilterRes ? `AND ${observationFilterRes.query}` : ""}
        GROUP BY trace_id, project_id
      )`
      : "";

  // Only build the scores aggregate when actually filtering/ordering by a score
  // (requiresScoresJoin). The metrics SELECT no longer reads scores_avg — list
  // scores come from the separate getScoresForTraces query — so building it for
  // every metrics query was dead computation.
  const scores_avg_cte = requiresScoresJoin
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
      FROM ${tableFor(projectId, "spans")} t
      ${select === "metrics" || requiresObservationsJoin ? `LEFT JOIN observations_stats os on os.project_id = t.project_id and os.trace_id = t.trace_id` : ""}
      ${requiresScoresJoin ? `LEFT JOIN scores_avg s on s.project_id = t.project_id and s.trace_id = t.trace_id` : ""}
      WHERE t.project_id = {projectId: String}
      AND t.is_root = 1
      ${timeStampFilter ? `AND t.start_time >= DATE(DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY))` : ""}
      ${tracesFilterRes ? `AND ${tracesFilterRes.query}` : ""}
      ${search.query}
      ${dorisOrderBy}
      ${limit !== undefined && page !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
    `;

  // Define Doris-specific return type for metrics
  type DorisMetricsReturnType = Omit<
    TracesTableMetricsDorisReturnType,
    "scores_avg" | "score_categories"
  > & {
    // scores_avg: Array of struct objects ({col1, col2} from Doris struct), or JSON string
    scores_avg: string | Array<Record<string, unknown>>;
    score_categories: string | Array<string>; // Array<"name:value"> or JSON string
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
