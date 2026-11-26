import { tableFor } from "../doris/tableRouting";
import { commandDoris } from "../repositories/doris";

// Production ingestion writes one spans row per OTel span, and a parentless
// span is a trace root that carries the trace fields. The test helpers keep
// that shape: a trace record without a real root gets a stand-in root row
// (`t-<traceId>`), and parentless observations written before or after it
// take over the trace fields. Doris can only delete spans by trace here (the
// trace_metrics_agg MV has no span_id column), so the helper keeps every row
// it loaded for a trace; replacing a stand-in or updating the trace fields
// deletes the trace and loads its rows again.

type SpanRow = Record<string, unknown>;
type LoadRows = (rows: SpanRow[]) => Promise<void>;

// A row as the test passed it, before trace fields are stamped on. Event rows
// (mergeTraceFields false) carry their own trace fields.
type LoadedRow = { row: SpanRow; mergeTraceFields: boolean };

type TraceState = {
  standIn?: SpanRow;
  hasRealRoot: boolean;
  rows: LoadedRow[];
};

// Rows to load for one trace, and whether its existing rows are deleted first.
type TraceWrite = { replace: boolean; rows: SpanRow[] };

const traceStates = new Map<string, TraceState>();
const projectWrites = new Map<string, Promise<void>>();

const traceKey = (projectId: string, traceId: string) =>
  `${projectId}:${traceId}`;

export const standInRootSpanId = (traceId: string) => `t-${traceId}`;

// Runs one project's spans writes one at a time, so a trace replaced by one
// call cannot delete rows that a concurrent call has just loaded.
const runInOrder = async (
  projectId: string,
  task: () => Promise<void>,
): Promise<void> => {
  const previous = projectWrites.get(projectId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  projectWrites.set(projectId, current);
  try {
    await current;
  } finally {
    if (projectWrites.get(projectId) === current) {
      projectWrites.delete(projectId);
    }
  }
};

// Trace-level fields that live on the root span in production. Input and
// output are not among them: the root span row keeps its own.
const TRACE_ROOT_FIELDS = [
  "trace_name",
  "user_id",
  "session_id",
  "release",
  "tags",
  "bookmarked",
  "public",
] as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const withTraceFields = (row: SpanRow, standIn: SpanRow): SpanRow => ({
  ...row,
  ...Object.fromEntries(TRACE_ROOT_FIELDS.map((f) => [f, standIn[f]])),
  // Ingestion merges trace metadata over the span's own metadata.
  metadata: { ...asRecord(row.metadata), ...asRecord(standIn.metadata) },
});

const stampRoot = (loaded: LoadedRow, standIn: SpanRow | undefined) =>
  standIn && loaded.mergeTraceFields && loaded.row.is_root === 1
    ? withTraceFields(loaded.row, standIn)
    : loaded.row;

const planTraceRecord = (
  key: string,
  standIn: SpanRow,
): TraceWrite | undefined => {
  const state = traceStates.get(key) ?? { hasRealRoot: false, rows: [] };
  traceStates.set(key, { ...state, standIn });
  if (state.hasRealRoot) {
    // The real roots take the new trace fields; events keep their own.
    const needsUpdate = state.rows.some(
      (r) => r.mergeTraceFields && r.row.is_root === 1,
    );
    if (!needsUpdate) return undefined;
    return {
      replace: true,
      rows: state.rows.map((loaded) => stampRoot(loaded, standIn)),
    };
  }
  return state.standIn
    ? { replace: true, rows: [...state.rows.map((r) => r.row), standIn] }
    : { replace: false, rows: [standIn] };
};

const planSpanRows = (
  key: string,
  rows: SpanRow[],
  mergeTraceFields: boolean,
): TraceWrite => {
  const state = traceStates.get(key) ?? { hasRealRoot: false, rows: [] };
  const loaded = rows.map((row) => ({ row, mergeTraceFields }));
  const hasRoot = rows.some((row) => row.is_root === 1);
  traceStates.set(key, {
    ...state,
    hasRealRoot: state.hasRealRoot || hasRoot,
    rows: [...state.rows, ...loaded],
  });
  const stamp = (r: LoadedRow) => stampRoot(r, state.standIn);
  // The first real root replaces the stand-in row.
  if (hasRoot && state.standIn && !state.hasRealRoot) {
    return { replace: true, rows: [...state.rows, ...loaded].map(stamp) };
  }
  return { replace: false, rows: loaded.map(stamp) };
};

// A later write that replaces the trace already includes the earlier rows.
const combine = (earlier: TraceWrite | undefined, later: TraceWrite) =>
  !earlier || later.replace
    ? later
    : { replace: earlier.replace, rows: [...earlier.rows, ...later.rows] };

const deleteTraces = async (projectId: string, traceIds: string[]) => {
  if (traceIds.length === 0) return;
  await commandDoris({
    query: `DELETE FROM ${tableFor(projectId, "spans")} WHERE project_id = {projectId: String} AND trace_id IN ({traceIds: Array(String)})`,
    params: { projectId, traceIds },
    tags: { feature: "test-utils", kind: "replace-trace-spans", projectId },
  });
};

const executeWrites = async (params: {
  projectId: string;
  writes: Map<string, TraceWrite>;
  untracked: SpanRow[];
  load: LoadRows;
}): Promise<void> => {
  const { projectId, writes, untracked, load } = params;
  const replacedTraceIds = [...writes]
    .filter(([, write]) => write.replace)
    .map(([traceId]) => traceId);
  await deleteTraces(projectId, replacedTraceIds);
  const rows = [...untracked, ...[...writes.values()].flatMap((w) => w.rows)];
  if (rows.length > 0) await load(rows);
};

/** Writes the stand-in root rows of trace records. */
export const writeTraceRecordSpans = async (params: {
  projectId: string;
  standIns: SpanRow[];
  load: LoadRows;
}): Promise<void> => {
  const { projectId, standIns, load } = params;
  await runInOrder(projectId, async () => {
    const writes = new Map<string, TraceWrite>();
    for (const standIn of standIns) {
      const traceId = String(standIn.trace_id);
      const write = planTraceRecord(traceKey(projectId, traceId), standIn);
      if (write) writes.set(traceId, combine(writes.get(traceId), write));
    }
    await executeWrites({ projectId, writes, untracked: [], load });
  });
};

/**
 * Writes observation or event rows. Parentless rows are trace roots; with
 * mergeTraceFields they take the trace fields of the trace record.
 */
export const writeObservationSpans = async (params: {
  projectId: string;
  rows: SpanRow[];
  mergeTraceFields: boolean;
  load: LoadRows;
}): Promise<void> => {
  const { projectId, rows, mergeTraceFields, load } = params;
  const byTrace = new Map<string, SpanRow[]>();
  const untracked: SpanRow[] = [];
  for (const row of rows) {
    const traceId = row.trace_id ? String(row.trace_id) : "";
    if (!traceId) {
      untracked.push(row);
      continue;
    }
    byTrace.set(traceId, [...(byTrace.get(traceId) ?? []), row]);
  }
  await runInOrder(projectId, async () => {
    const writes = new Map<string, TraceWrite>();
    for (const [traceId, traceRows] of byTrace) {
      const key = traceKey(projectId, traceId);
      writes.set(traceId, planSpanRows(key, traceRows, mergeTraceFields));
    }
    await executeWrites({ projectId, writes, untracked, load });
  });
};

/** Deletes a trace's spans rows and forgets what the helper loaded for it. */
export const deleteTraceSpans = async (params: {
  projectId: string;
  traceId: string;
}): Promise<void> => {
  const { projectId, traceId } = params;
  await runInOrder(projectId, async () => {
    await deleteTraces(projectId, [traceId]);
    traceStates.delete(traceKey(projectId, traceId));
  });
};
