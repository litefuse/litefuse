// ── LITEFUSE NOTE (authored; replaces five upstream repository readers) ─────
// Upstream answers "which traces did this evaluator/rule run against recently?"
// from ClickHouse, and "what did this evaluator/rule cost?" likewise. Our split
// `spans_<projectId>` tables have no execution-ownership COLUMN either, but the
// dodge is different per side:
//
//   * a RULE's recent runs  = Postgres `job_executions` rows. Our worker records
//     the v2 RULE id in `job_executions.job_configuration_id` — a documented
//     deviation, see worker/src/features/evaluation/v2LlmEvaluatorExecution.ts,
//     v2DecisionModelExecution.ts and observationEval/createSchedulerDeps.ts — so
//     the rows are genuinely the rule's own runs.
//   * an EVALUATOR's recent runs = Doris execution traces, grouped by the
//     `evaluator_id` key the executor stamps on its internal execution trace
//     (environment `langfuse-llm-as-a-judge`). This mirrors upstream, which
//     groups events by `e.evaluator_id` over the last seven days.
//     `job_executions` CANNOT answer this question: the table has only
//     `job_configuration_id`, so when one rule has N evaluators attached every
//     hit writes N indistinguishable rows and every evaluator sees all N.
//
//   * per-rule / per-evaluator COST reporting stays CANCELLED
//     (`getTotalCostByRule`, `getTotalCostByEvaluatorIds` and
//     `getLatestEvaluatorRunCost` below still return `[]` / `null`): we have no
//     equivalent of upstream's cost aggregation, and the feature is not worth the
//     storage work it would need.
//
// What the evaluator reader returns, and why
//   The consumers (web/src/features/evals/v2/server/evaluators/evaluatorService.ts
//   and .../rules/ruleService.ts) hand the array to `EvaluatorExecutionHistory`
//   (web/src/features/evals/v2/components/Rules/EvaluatorExecutionHistory/
//   EvaluatorExecutionHistory.tsx), which renders one marker per entry, oldest
//   first, and colours it by `level`:
//     * `id`        — the execution trace id. The component currently uses it
//       only as a React key, but a real trace id is the only honest value.
//     * `level`     — "ERROR" as soon as ANY span of that execution trace is
//       ERROR (upstream: `countIf(e.level = 'ERROR') > 0`), "WARNING" when the
//       root span is a warning, "DEFAULT" otherwise. The executor writes an
//       ERROR-level root span for a failed execution
//       (worker/src/features/evaluation/v2InternalTrace.ts), so a failure is
//       visible instead of the run simply vanishing.
//     * `timestamp` — the execution trace's `start_time`.
//   Extra fields (`failed`, `name`, `statusMessage`, `durationMs`) are carried
//   for tooltips; nothing depends on them yet.
//
// Knowing limitations
//   (a) Only executions that already ran are listed — a queue job that is still
//       PENDING/DELAYED has no trace yet, and a cancelled job never gets one.
//   (b) Execution traces written BEFORE the executor started stamping
//       `evaluator_id` (and failure traces, which are new) cannot be attributed
//       backwards: only new runs appear.
//   (c) A rule that matched nothing shows no markers; the Rules table's existing
//       "View traces" link covers the "what would this rule evaluate" side.
//   (d) Cost stays cancelled (see above).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma, Prisma, type JobExecutionStatus } from "../../db";
import { LangfuseInternalTraceEnvironment } from "../llm/types";
import { tableFor } from "../doris/tableRouting";
import {
  isMissingSplitTableReadError,
  logMissingReadTarget,
} from "../doris/crossProjectTableRouting";
import { parseDorisUTCDateTimeFormat, queryDoris } from "./doris";

/** How many markers the "Last 5 runs" column shows per row (upstream: 5). */
const RECENT_RUNS_PER_OWNER = 5;

/** How far back an evaluator's execution history reaches (upstream: 7 days). */
const RECENT_EXECUTION_WINDOW_DAYS = 7;

/**
 * The environment every evaluator execution trace is written under. Internal
 * `langfuse-` environments are never evaluated themselves, which is also what
 * keeps an eval from being scheduled on its own telemetry.
 */
const EVALUATOR_EXECUTION_ENVIRONMENT =
  LangfuseInternalTraceEnvironment.LLMJudge;

/** A `job_executions` row projected to what the rule reader needs. */
type RecentExecutionRow = {
  owner_id: string;
  execution_trace_id: string | null;
  job_input_trace_id: string | null;
  status: JobExecutionStatus;
  created_at: Date;
};

type RecentExecution = {
  ownerId: string;
  id: string;
  level: string;
  timestamp: Date;
};

/** One evaluator execution, as read from its internal execution trace. */
export type RecentEvaluatorExecution = {
  evaluatorId: string;
  id: string;
  level: string;
  timestamp: Date;
  /** True when any span of the execution trace is at ERROR level. */
  failed: boolean;
  /** The execution trace's name, e.g. `Execute evaluator: <score name>`. */
  name: string | null;
  /** The failure reason the executor recorded on the trace, when it failed. */
  statusMessage: string | null;
  /** `end_time` of the selected span, when Doris has one. */
  endTimestamp: Date | null;
  /** Execution duration in milliseconds, when both ends are known. */
  durationMs: number | null;
};

/** The Doris row the evaluator reader selects. */
type DorisEvaluatorExecutionRow = {
  evaluator_id: string;
  trace_id: string;
  span_id: string;
  name: string | null;
  level: string | null;
  status_message: string | null;
  start_time: string;
  end_time: string | null;
  failed: boolean | number | null;
};

/**
 * The marker colour the UI understands. `EvaluatorExecutionHistory` branches on
 * exactly these three strings, and upstream derives the same three from span
 * levels (`multiIf(countIf(e.level = 'ERROR') > 0, 'ERROR', …)`).
 */
function toExecutionLevel(status: JobExecutionStatus): string {
  if (status === "ERROR") return "ERROR";
  if (status === "CANCELLED") return "WARNING";
  return "DEFAULT";
}

/**
 * The newest executions per `job_configuration_id` owner, newest first.
 *
 * `ownerId` is a `job_executions.job_configuration_id` value, which our worker
 * anchors on the v2 rule id (see the file header). `PARTITION BY` +
 * `ROW_NUMBER()` is the Postgres spelling of upstream's `limitByCount(5, …)`, so
 * one round trip returns at most `perOwner` rows per owner instead of a shared
 * window that a busy owner could fill on its own. The filter is served by the
 * `(project_id, job_configuration_id, job_input_trace_id)` index.
 */
async function findRecentExecutionsByOwner(params: {
  projectId: string;
  ownerIds: string[];
  perOwner?: number;
}): Promise<RecentExecution[]> {
  const ownerIds = [...new Set(params.ownerIds)];
  if (ownerIds.length === 0) return [];

  const perOwner = Math.max(
    1,
    Math.floor(params.perOwner ?? RECENT_RUNS_PER_OWNER),
  );

  const rows = await prisma.$queryRaw<RecentExecutionRow[]>(Prisma.sql`
    SELECT ranked.owner_id,
           ranked.execution_trace_id,
           ranked.job_input_trace_id,
           ranked.status,
           ranked.created_at
    FROM (
      SELECT je.job_configuration_id AS owner_id,
             je.execution_trace_id,
             je.job_input_trace_id,
             je.status,
             je.created_at,
             ROW_NUMBER() OVER (
               PARTITION BY je.job_configuration_id
               ORDER BY je.created_at DESC, je.id DESC
             ) AS run_rank
      FROM job_executions je
      WHERE je.project_id = ${params.projectId}
        AND je.job_configuration_id = ANY(${ownerIds})
    ) ranked
    WHERE ranked.run_rank <= ${perOwner}
    ORDER BY ranked.created_at DESC, ranked.owner_id, ranked.run_rank
  `);

  return rows.flatMap((row) => {
    // `execution_trace_id` is the evaluator's own trace (written by the v2
    // executors when they persist a score); `job_input_trace_id` is the target
    // trace, the only id available on rows that never reached execution.
    const id = row.execution_trace_id ?? row.job_input_trace_id;
    if (!id) return [];

    return [
      {
        ownerId: row.owner_id,
        id,
        level: toExecutionLevel(row.status),
        timestamp: row.created_at,
      },
    ];
  });
}

/** Cancelled feature: per-rule cost reporting. Returns no costs. */
export async function getTotalCostByRule(
  _projectId: string,
  _ruleIds: string[],
): Promise<Array<{ ruleId: string; totalCost: number }>> {
  return [];
}

/** Cancelled feature: per-evaluator cost reporting. Returns no costs. */
export async function getTotalCostByEvaluatorIds(
  _projectId: string,
  _evaluatorIds: string[],
): Promise<Array<{ evaluatorId: string; totalCost: number }>> {
  return [];
}

/**
 * The newest executions of each rule, at most five per rule, newest first.
 *
 * Implemented from `job_executions` (see the file header): our worker writes the
 * v2 rule id into `job_configuration_id`, so those rows are the rule's executed
 * runs. Deliberately unchanged by the evaluator-side rewrite — a rule is a
 * `job_configurations` row, and `job_executions` is its own ledger.
 */
export async function getRecentRuleExecutionTraces(
  projectId: string,
  ruleIds: string[],
): Promise<
  Array<{ ruleId: string; id: string; level: string; timestamp: Date }>
> {
  const runs = await findRecentExecutionsByOwner({
    projectId,
    ownerIds: ruleIds,
  });

  return runs.map(({ ownerId, id, level, timestamp }) => ({
    ruleId: ownerId,
    id,
    level,
    timestamp,
  }));
}

/**
 * The newest executions of each evaluator, at most five per evaluator, newest
 * first, read from the evaluator's own execution traces in `spans_<projectId>`.
 *
 * `metadata['evaluator_id']` is what the executor stamps on the execution trace
 * (worker/src/features/evaluation/v2DecisionModelExecution.ts,
 * v2LlmEvaluatorExecution.ts), so the aggregation answers "what did THIS
 * evaluator run" — the question `job_executions` cannot answer at all when a
 * rule has several evaluators attached (see the file header).
 *
 * Doris notes (both learned the hard way):
 *   * `spans.metadata` is a VARIANT column. A bare subfield read is
 *     VARIANT-typed and Doris refuses it in WHERE/GROUP BY, so every read is
 *     wrapped in `CAST(... AS STRING)` (same idiom as
 *     `getAvgCostByEvaluatorIds` above).
 *   * Execution traces can carry more than one root span (a failed LLM-judge run
 *     leaves the partial trace the callback handler exported plus the ERROR
 *     marker the executor writes), so roots are collapsed to ONE row per
 *     `(evaluator_id, trace_id)` before ranking.
 *   * The failure probe is bounded by the same seven days as the roots: an
 *     execution trace's spans all start after its root, so the bound cannot hide
 *     a failure, and it keeps Doris from scanning every partition (the table is
 *     auto-partitioned by day) just to look for ERROR levels.
 */
export async function getRecentEvaluatorExecutionTraces(
  projectId: string,
  evaluatorIds: string[],
): Promise<RecentEvaluatorExecution[]> {
  const uniqueEvaluatorIds = [...new Set(evaluatorIds)].filter(Boolean);
  if (uniqueEvaluatorIds.length === 0) return [];

  const query = `
    WITH roots AS (
      SELECT
        CAST(s.metadata['evaluator_id'] AS STRING) AS evaluator_id,
        s.trace_id,
        s.span_id,
        s.name,
        s.level,
        s.status_message,
        s.start_time,
        s.end_time,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(s.metadata['evaluator_id'] AS STRING), s.trace_id
          ORDER BY s.start_time ASC, s.span_id ASC
        ) AS trace_rank
      FROM ${tableFor(projectId, "spans")} s
      WHERE s.project_id = {projectId: String}
        AND s.is_root = 1
        AND s.environment = {environment: String}
        AND CAST(s.metadata['evaluator_id'] AS STRING) IS NOT NULL
        AND CAST(s.metadata['evaluator_id'] AS STRING) IN ({evaluatorIds: Array(String)})
        AND s.start_time >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${RECENT_EXECUTION_WINDOW_DAYS} DAY)
    ),
    per_trace AS (
      SELECT * FROM roots WHERE trace_rank = 1
    ),
    ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY evaluator_id
          ORDER BY start_time DESC, trace_id DESC
        ) AS run_rank
      FROM per_trace
    ),
    error_traces AS (
      SELECT x.trace_id AS trace_id, count() AS error_count
      FROM ${tableFor(projectId, "spans")} x
      WHERE x.project_id = {projectId: String}
        AND x.level = 'ERROR'
        AND x.start_time >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${RECENT_EXECUTION_WINDOW_DAYS} DAY)
        AND x.trace_id IN (SELECT trace_id FROM per_trace)
      GROUP BY x.trace_id
    )
    SELECT
      ranked.evaluator_id,
      ranked.trace_id,
      ranked.span_id,
      ranked.name,
      ranked.level,
      ranked.status_message,
      ranked.start_time,
      ranked.end_time,
      COALESCE(error_traces.error_count, 0) > 0 AS failed
    FROM ranked
    LEFT JOIN error_traces ON error_traces.trace_id = ranked.trace_id
    WHERE ranked.run_rank <= {perOwner: Int32}
    ORDER BY ranked.evaluator_id, ranked.run_rank
  `;

  const rows = await queryDoris<DorisEvaluatorExecutionRow>({
    query,
    params: {
      projectId,
      environment: EVALUATOR_EXECUTION_ENVIRONMENT,
      evaluatorIds: uniqueEvaluatorIds,
      perOwner: RECENT_RUNS_PER_OWNER,
    },
    tags: {
      feature: "evals",
      type: "recent-executions",
      kind: "analytic",
      projectId,
    },
  }).catch((e: unknown) => {
    // A project only gets `spans_<projectId>` when it first ingests telemetry, so
    // a project that has evaluators but no traces yet has no table to read. Reads
    // are specified to degrade to an empty result in that case (the cross-project
    // fan-out does the same via `executeDorisProjectFanout`); without this the
    // evaluators page fails with a 500 instead of showing "no runs yet".
    if (isMissingSplitTableReadError(e)) {
      logMissingReadTarget("spans", tableFor(projectId, "spans"));
      return [] as DorisEvaluatorExecutionRow[];
    }
    throw e;
  });

  return rows.map((row) => {
    const timestamp = parseDorisUTCDateTimeFormat(row.start_time);
    const endTimestamp = row.end_time
      ? parseDorisUTCDateTimeFormat(row.end_time)
      : null;
    const failed = row.failed === true || row.failed === 1;

    return {
      evaluatorId: row.evaluator_id,
      id: row.trace_id,
      level: failed
        ? "ERROR"
        : row.level === "ERROR" || row.level === "WARNING"
          ? row.level
          : "DEFAULT",
      timestamp,
      failed,
      name: row.name ?? null,
      statusMessage: row.status_message ?? null,
      endTimestamp,
      durationMs:
        endTimestamp === null
          ? null
          : Math.max(0, endTimestamp.getTime() - timestamp.getTime()),
    };
  });
}

/**
 * The most recent run cost for an evaluator card. Upstream derives it from
 * execution rows; with cost reporting cancelled there is nothing to report, and
 * `null` is a value the callers and their tests already treat as "unknown".
 */
export async function getLatestEvaluatorRunCost(
  _projectId: string,
  _evaluatorId: string,
): Promise<number | null> {
  return null;
}
