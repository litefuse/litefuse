import { OrderByState } from "../../interfaces/orderBy";
import { FilterState } from "../../types";
import { parseDorisUTCDateTimeFormat } from "../repositories/doris";
import { parseDorisStringArray } from "../utils/dorisArrays";

// Doris imports
import { queryDoris } from "../repositories";
import { tableFor } from "../doris/tableRouting";
import {
  getSessionsTable,
  getSessionsTableCount,
} from "./sessions-ui-table-service";

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
  // Reads traces_scalar (one row per trace — migration 0039, idx_session_id)
  // instead of an is_root = 1 spans scan. Deletion is physical on
  // traces_scalar (deleteTraces removes the row), so the old is_deleted = 0
  // predicate has no counterpart here. `name` is the explicit trace name
  // (scalar name ← trace_name), matching what the migrated traces list shows.
  const query = `
    SELECT
      id,
      COALESCE(name, '') AS name,
      start_time AS \`timestamp\`,
      environment,
      COALESCE(user_id, '') AS user_id
    FROM ${tableFor(props.projectId, "traces_scalar")} t
    WHERE t.session_id = {sessionId: String}
      AND t.project_id = {projectId: String}
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
  return getSessionsTableCount(props);
};

export const getSessionsTableFromEvents = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}): Promise<SessionEventsDataReturnType[]> => {
  const rows = await getSessionsTable(props);

  return rows.map((row) => ({
    session_id: row.session_id,
    max_timestamp: row.max_timestamp,
    min_timestamp: row.min_timestamp,
    trace_count: Number(row.trace_count),
    trace_ids: parseDorisStringArray(row.trace_ids),
    user_ids: parseDorisStringArray(row.user_ids),
    trace_tags: parseDorisStringArray(row.trace_tags),
    environment: row.trace_environment,
    ...(row.scores_avg !== undefined ? { scores_avg: row.scores_avg } : {}),
    ...(row.score_categories !== undefined
      ? { score_categories: row.score_categories }
      : {}),
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
