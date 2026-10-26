import { convertDateToAnalyticsDateTime } from "../../repositories/analyticsDateTime";

/**
 * Keyset ("cursor") pagination over the events/spans table.
 *
 * Lives in the Doris SQL-builder layer (not the repository) so the SQL
 * fragments, the parameter binding and the invariants that make them sound are
 * unit-testable without a database — importing the repository would drag in
 * Prisma/env/OTel. Kept as a leaf module: the only import is the zero-import
 * datetime formatter.
 *
 * Consumers: `getObservationsFromEventsTableInternal` (internal events list) and
 * `applyCursorPagination` (public API observations) in
 * `src/server/repositories/events.ts`, so the two paths can never drift apart.
 */

/**
 * The cursor is the last row of the previous page, encoded as the triple its
 * total order is built from: (start_time, trace_id, span_id).
 */
export type EventsCursor = {
  lastStartTimeTo: Date;
  lastTraceId: string;
  lastId: string;
};

/**
 * Opt-in cursor pagination parameters. Purely additive: every caller that does
 * not pass `cursorPagination` keeps the plain LIMIT/OFFSET path unchanged.
 */
export type EventsCursorPaginationParams = {
  cursorPagination?: boolean;
  cursor?: EventsCursor;
};

/**
 * Total order the cursor triple encodes.
 *
 * Without the tie-breakers Doris may return rows that share a start_time in a
 * different order on every query — under keyset pagination that duplicates or
 * skips rows across page boundaries. `EVENTS_CURSOR_KEYSET_WHERE` advances over
 * exactly this triple, so the two must always be used together (asserted by
 * `eventsCursor.unit.test.ts`).
 */
export const EVENTS_CURSOR_ORDER_BY =
  "ORDER BY o.start_time DESC, o.trace_id DESC, o.span_id DESC";

/**
 * Strict "(start_time, trace_id, span_id) < (cursor)" predicate.
 *
 * Doris has no tuple/row comparison (`(a, b, c) < (x, y, z)` works in
 * ClickHouse/Postgres but not Doris), so the keyset comparison is expanded into
 * its boolean-equivalent form:
 *
 *   start_time <  X
 *   OR (start_time = X AND trace_id <  Y)
 *   OR (start_time = X AND trace_id =  Y AND span_id < Z)
 *
 * The outer `start_time <= X` bound is redundant for correctness but keeps the
 * scan prunable: start_time sits in the split table's sort key, so the bound
 * lets Doris skip partitions/segments that cannot contain the next page.
 *
 * The placeholders are bound by `eventsCursorKeysetParams` and substituted by
 * DorisParameterProcessor, exactly like every other `{name: Type}` parameter in
 * this query layer.
 */
export const EVENTS_CURSOR_KEYSET_WHERE = `
      AND o.start_time <= {lastStartTime: String}
      AND (
        o.start_time < {lastStartTime: String}
        OR (o.start_time = {lastStartTime: String} AND o.trace_id < {lastTraceId: String})
        OR (o.start_time = {lastStartTime: String} AND o.trace_id = {lastTraceId: String} AND o.span_id < {lastId: String})
      )`;

/**
 * Bind the values used by `EVENTS_CURSOR_KEYSET_WHERE`. `start_time` is
 * DateTime(3) in Doris and the cursor crossed the tRPC boundary as a JS Date,
 * so the millisecond-precision UTC string produced here is exact — no rows can
 * be skipped at a page boundary.
 */
export const eventsCursorKeysetParams = (
  cursor: EventsCursor,
): Record<string, unknown> => ({
  lastStartTime: convertDateToAnalyticsDateTime(cursor.lastStartTimeTo),
  lastTraceId: cursor.lastTraceId,
  lastId: cursor.lastId,
});
