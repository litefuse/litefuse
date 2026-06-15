import { OrderByState } from "../../interfaces/orderBy";
import { FilterState } from "../../types";
import { sessionColsForDoris } from "../tableMappings/mapSessionTable";
import { parseDorisUTCDateTimeFormat } from "../repositories/doris";
import { convertDateToAnalyticsDateTime } from "../repositories/analytics";
import { parseDorisStringArray } from "../utils/dorisArrays";

// Doris imports
import { queryDoris } from "../repositories";
import {
  createDorisFilterFromFilterState,
  getDorisProjectIdDefaultFilter,
} from "../queries/doris-sql/factory";
import { orderByToDorisSQL } from "../queries/doris-sql/orderby-factory";
import {
  StringFilter as DorisStringFilter,
  StringOptionsFilter as DorisStringOptionsFilter,
  DateTimeFilter as DorisDateTimeFilter,
} from "../queries/doris-sql/doris-filter";

type SessionEventsBaseReturnType = {
  session_id: string;
  max_timestamp: string;
  min_timestamp: string;
  trace_ids: string[];
  user_ids: string[];
  trace_count: number;
  trace_tags: string[];
  environment?: string;
};

type SessionScoreFields = {
  scores_avg?: Array<Array<[string, number]>>;
  score_categories?: Array<Array<string>>;
};

export type SessionEventsDataReturnType = SessionEventsBaseReturnType &
  SessionScoreFields;

export type SessionTraceFromEvents = {
  id: string;
  name: string | null;
  timestamp: Date;
  environment: string | null;
  userId: string | null;
};

export const getSessionTracesFromEvents = async (props: {
  projectId: string;
  sessionId: string;
}) => {
  // Reads synthetic trace spans (parent_span_id = '') from events_full.
  const query = `
    SELECT
      trace_id AS id,
      name,
      start_time AS \`timestamp\`,
      environment,
      user_id
    FROM events_full t
    WHERE t.session_id = {sessionId: String}
      AND t.project_id = {projectId: String}
      AND t.parent_span_id = ''
      AND t.is_deleted = 0
    ORDER BY start_time ASC
  `;

  const rows = await queryDoris<{
    id: string;
    name: string | null;
    timestamp: string;
    environment: string | null;
    user_id: string | null;
  }>({
    query,
    params: {
      projectId: props.projectId,
      sessionId: props.sessionId,
    },
    tags: {
      feature: "tracing",
      type: "sessions-traces",
      projectId: props.projectId,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    timestamp: parseDorisUTCDateTimeFormat(row.timestamp),
    environment: row.environment,
    userId: row.user_id,
  }));
};

export const getSessionsTableCountFromEvents = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}) => {
  const rows = await getSessionsTableFromEventsGeneric<{ count: string }>({
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

export const getSessionsTableFromEvents = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}) => {
  const rows =
    await getSessionsTableFromEventsGeneric<SessionEventsDataReturnType>({
      select: "rows",
      projectId: props.projectId,
      filter: props.filter,
      orderBy: props.orderBy,
      limit: props.limit,
      page: props.page,
      tags: { kind: "list" },
    });

  // Doris returns ARRAY columns as JSON-encoded strings; normalize the
  // collect_set() outputs so downstream consumers can rely on the declared
  // string[] types (e.g. `.length`, `.filter`). See dorisArrays.ts.
  return rows.map((row) => ({
    ...row,
    trace_count: Number(row.trace_count),
    trace_ids: parseDorisStringArray(row.trace_ids),
    user_ids: parseDorisStringArray(row.user_ids),
    trace_tags: parseDorisStringArray(row.trace_tags),
  }));
};

export type FetchSessionsTableFromEventsProps = {
  select: "count" | "rows" | "metrics";
  projectId: string;
  filter: FilterState;
  searchQuery?: string;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
  tags?: Record<string, string>;
};

const getSessionsTableFromEventsGeneric = async <T>(
  props: FetchSessionsTableFromEventsProps,
) => {
  const { select, projectId, filter, orderBy, limit, page } = props;

  const { tracesFilter } = getDorisProjectIdDefaultFilter(projectId, {
    tracesPrefix: "t",
  });

  tracesFilter.push(
    ...createDorisFilterFromFilterState(filter, sessionColsForDoris),
  );

  const sessionFilters = tracesFilter;
  const sessionsFilterRes = sessionFilters.apply();

  const traceTimestampFilter = sessionFilters.find(
    (f) =>
      f.field === "min_timestamp" &&
      (f.operator === ">=" || f.operator === ">"),
  ) as DorisDateTimeFilter | undefined;

  const sessionIdFilter = sessionFilters.find(
    (f) => f instanceof DorisStringOptionsFilter && f.field === "session_id",
  ) as DorisStringOptionsFilter | undefined;

  // Build the base query with Doris SQL.
  let sqlSelect: string;
  switch (select) {
    case "count":
      sqlSelect = "count(DISTINCT t.session_id) as count";
      break;
    case "rows":
      sqlSelect = `
        t.session_id,
        max(t.start_time) as max_timestamp,
        min(t.start_time) as min_timestamp,
        collect_set(t.trace_id) AS trace_ids,
        collect_set(CASE WHEN t.user_id IS NOT NULL AND t.user_id != '' THEN t.user_id ELSE NULL END) AS user_ids,
        count(DISTINCT t.trace_id) as trace_count,
        -- Doris collect_set/collect_list don't accept ARRAY inputs directly
        -- (returns "unexpected type for collect"), so we collect_list to
        -- ARRAY<ARRAY>, flatten, then distinct.
        array_distinct(array_flatten(collect_list(t.tags))) AS trace_tags,
        any_value(t.environment) as environment
      `;
      break;
    default:
      throw new Error(`Unknown select type: ${select}`);
  }

  const traceTimestampFilterClause = traceTimestampFilter
    ? `AND t.start_time >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY)`
    : "";

  const traceTimestampValue = traceTimestampFilter
    ? convertDateToAnalyticsDateTime(traceTimestampFilter.value)
    : null;

  const query = `
    SELECT ${sqlSelect}
    FROM events_full t
    WHERE t.project_id = {projectId: String}
      AND t.parent_span_id = ''
      AND t.session_id IS NOT NULL
      ${traceTimestampFilterClause}
      ${sessionsFilterRes.query ? `AND ${sessionsFilterRes.query}` : ""}
    GROUP BY t.session_id
    ${orderByToDorisSQL(orderBy ? [orderBy] : null, sessionColsForDoris)}
    ${limit !== undefined && page !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
  `;

  const res = await queryDoris<T>({
    query,
    params: {
      projectId,
      limit: limit,
      offset: limit && page ? limit * page : 0,
      ...(traceTimestampValue ? { traceTimestamp: traceTimestampValue } : {}),
      ...sessionsFilterRes.params,
    },
    tags: {
      ...(props.tags ?? {}),
      feature: "tracing",
      type: "sessions-table",
      projectId,
    },
  });

  return res;
};
