// Tracing page — Doris-backed read queries.
//
// Covers: Traces list tab, Observations tab (generations.*), trace detail
// (byId / byIdWithObservationsAndScores / getAgentGraphData / observations.byId),
// and the table chrome (filterOptions / score columns / environments).
//
// Non-Doris queries the page also fires (TableViewPresets.*, comments.*, media.*,
// annotationQueues.*, datasets.*) are PostgreSQL/S3 and intentionally omitted —
// this project isolates Doris read latency.
//
// Inputs were captured from a real page HAR and verified against the running app;
// the time window is computed at runtime so the test stays portable.
import { PROJECT_ID, displayWindow, wideWindow } from "../lib/config.js";
import { trpcGet } from "../lib/trpc.js";

const PID = PROJECT_ID;

// Environments the Tracing UI hides by default.
const EXCLUDED_ENVS = [
  "langfuse-prompt-experiment",
  "langfuse-llm-as-a-judge",
  "langfuse-evaluation",
  "sdk-experiment",
];
const envFilter = () => ({
  column: "environment",
  type: "stringOptions",
  operator: "none of",
  value: EXCLUDED_ENVS,
});
const dt = (column, operator, value) => ({
  column,
  type: "datetime",
  operator,
  value,
});

const traceFilter = (w) => [
  envFilter(),
  dt("timestamp", ">=", w.from),
  dt("timestamp", "<=", w.to),
];
const genFilter = (w) => [
  envFilter(),
  dt("startTime", ">=", w.from),
  dt("startTime", "<=", w.to),
];

export const name = "tracing";

// Static proc list — used to declare Trends in the init context.
export const procs = [
  "traces.all",
  "traces.countAll",
  "traces.metrics",
  "traces.filterOptions",
  "traces.hasTracingConfigured",
  "scores.getScoreColumns",
  "projects.environmentFilterOptions",
  "generations.all",
  "generations.countAll",
  "generations.filterOptions",
  "traces.byId",
  "traces.byIdWithObservationsAndScores",
  "traces.getAgentGraphData",
  "observations.byId",
];

// Discover real trace/observation ids (wide window → always finds data) so the
// detail queries hit real rows.
export function discover(cookie) {
  const w = wideWindow();
  const tr =
    trpcGet(
      "traces.all",
      {
        projectId: PID,
        filter: traceFilter(w),
        searchQuery: null,
        searchType: ["id"],
        page: 0,
        limit: 20,
        orderBy: { column: "timestamp", order: "DESC" },
      },
      cookie,
    ) || {};
  const traces = (tr.traces || []).map((t) => ({
    id: t.id,
    timestamp: t.timestamp,
  }));

  const ge =
    trpcGet(
      "generations.all",
      {
        projectId: PID,
        filter: genFilter(w),
        searchQuery: null,
        searchType: ["id"],
        page: 0,
        limit: 20,
        orderBy: { column: "startTime", order: "DESC" },
      },
      cookie,
    ) || {};
  const observations = (ge.generations || []).map((g) => ({
    id: g.id,
    traceId: g.traceId,
    startTime: g.startTime,
  }));

  return { traces, observations };
}

// Build the full query list for one page "load", using discovered ids.
// (setup→default serializes Dates to strings, so coerce back with new Date().)
export function queries({ ids }) {
  const w = displayWindow();
  const traces = (ids && ids.traces) || [];
  const observations = (ids && ids.observations) || [];
  const traceIds = traces.map((t) => t.id);
  const qs = [];

  // ---- Traces list tab ----
  const traceListInput = {
    projectId: PID,
    filter: traceFilter(w),
    searchQuery: null,
    searchType: ["id"],
    page: 0,
    limit: 50,
    orderBy: { column: "timestamp", order: "DESC" },
  };
  qs.push({ proc: "traces.all", input: traceListInput });
  qs.push({ proc: "traces.countAll", input: traceListInput });
  if (traceIds.length) {
    qs.push({
      proc: "traces.metrics",
      input: { projectId: PID, filter: traceFilter(w), traceIds },
    });
  }
  qs.push({
    proc: "traces.filterOptions",
    input: {
      projectId: PID,
      timestampFilter: [
        dt("timestamp", ">=", w.from),
        dt("timestamp", "<=", w.to),
      ],
    },
  });
  qs.push({ proc: "traces.hasTracingConfigured", input: { projectId: PID } });
  qs.push({
    proc: "scores.getScoreColumns",
    input: {
      projectId: PID,
      filter: [
        {
          type: "null",
          column: "observationId",
          operator: "is not null",
          value: "",
        },
      ],
      fromTimestamp: w.from,
      toTimestamp: undefined, // schema is optional date; superjson marks it undefined
    },
  });
  qs.push({
    proc: "projects.environmentFilterOptions",
    input: { projectId: PID, fromTimestamp: w.from },
  });

  // ---- Observations tab ----
  const genListInput = {
    projectId: PID,
    filter: genFilter(w),
    searchQuery: null,
    searchType: ["id"],
    page: 0,
    limit: 50,
    orderBy: { column: "startTime", order: "DESC" },
  };
  qs.push({ proc: "generations.all", input: genListInput });
  qs.push({ proc: "generations.countAll", input: genListInput });
  qs.push({
    proc: "generations.filterOptions",
    input: {
      projectId: PID,
      startTimeFilter: [
        dt("startTime", ">=", w.from),
        dt("startTime", "<=", w.to),
      ],
    },
  });

  // ---- Trace detail (first discovered trace) ----
  if (traces.length) {
    const t = traces[0];
    const ts = new Date(t.timestamp);
    qs.push({
      proc: "traces.byId",
      input: {
        traceId: t.id,
        projectId: PID,
        timestamp: ts,
        verbosity: "compact",
      },
    });
    qs.push({
      proc: "traces.byIdWithObservationsAndScores",
      input: { traceId: t.id, projectId: PID, timestamp: ts },
    });
    // getAgentGraphData expects plain ISO strings here (not Date-typed superjson).
    qs.push({
      proc: "traces.getAgentGraphData",
      input: {
        projectId: PID,
        traceId: t.id,
        minStartTime: t.timestamp,
        maxStartTime: t.timestamp,
      },
    });
  }

  // ---- Observation detail (first few discovered observations) ----
  for (const o of observations.slice(0, 5)) {
    qs.push({
      proc: "observations.byId",
      input: {
        observationId: o.id,
        traceId: o.traceId,
        projectId: PID,
        startTime: new Date(o.startTime),
        verbosity: "compact",
      },
    });
  }

  return qs;
}
