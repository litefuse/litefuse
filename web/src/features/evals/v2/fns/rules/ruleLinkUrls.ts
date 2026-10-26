// ── LITEFUSE ADDITION — the rules table's two deep links ─────────────────────
//
// "View traces" on a rule answers "which traces does this rule evaluate?" — that
// is exactly the rule's own filter, so the URL is that filter, forwarded to the
// traces list. (The rule's *executions* are not linkable: an execution trace is
// an internal `langfuse-*` trace, and the traces query has no column for the
// rule that produced it — the rule id only appears in score metadata. The
// previous link tried `ruleId` anyway; the traces surface drops that column, so
// the link pointed at an unfiltered list, i.e. at every trace in the project.)
//
// "View scores" answers "which scores did this rule's runs write?" — the score
// names come from Doris by `metadata['evaluation_rule_id']` (see
// `getScoreNamesByRuleIds`), because a rule does not name its scores: a decision
// model writes one score per question, so one rule can produce several names.
// The caller passes the names it read; with none there is nothing to filter on
// and the caller must not navigate.
// ─────────────────────────────────────────────────────────────────────────────

import {
  encodeFiltersGeneric,
  type FilterState,
  tracesTableCols,
} from "@langfuse/shared";

import { scoreNamesScoresUrl } from "../scoreNamesScoresUrl";

/**
 * Rule-filter column ids the traces surface exposes under another id. Mirrors
 * `traceFilterConfig.columnAliases` — kept local so the type check below can look
 * up the *target* column without importing a page-level config into a pure fn.
 */
const TRACE_COLUMN_ALIASES: Record<string, string> = {
  traceName: "name",
};

const TRACE_COLUMN_TYPES = new Map(
  tracesTableCols.map((column) => [column.id, column.type]),
);

/**
 * The part of a rule's filter the traces list can actually apply.
 *
 * A rule filter is an *observation* filter (`eventsEvalFilterColumns`), while
 * `/traces` filters whole traces, so the two column sets only partly overlap
 * (`type`, `input`, `providedModelName`, `parentObservationId`, … describe a
 * single observation and have no trace-level equivalent). Conditions that do not
 * cross over are DROPPED here rather than handed to the page, because the traces
 * surface would either discard them with a console warning or — for an id it
 * knows but has no Doris mapping for — throw while building the query.
 *
 * Dropping a narrowing condition widens the list, so it is never silently
 * correct: the sidebar shows exactly the conditions that made it through, and
 * the caller labels the link after the filter it was built from.
 */
export function ruleFilterToTraceFilter(ruleFilter: FilterState): FilterState {
  return ruleFilter.flatMap((condition) => {
    const targetId = TRACE_COLUMN_ALIASES[condition.column] ?? condition.column;
    const traceColumnType = TRACE_COLUMN_TYPES.get(targetId);

    // Not a traces column at all, or the same id means a different kind of
    // condition on this surface (e.g. a facet vs. a raw value) — do not forward.
    if (traceColumnType === undefined || traceColumnType !== condition.type) {
      return [];
    }

    return [{ ...condition }];
  });
}

/**
 * `/traces` filtered to what the rule evaluates. A rule with no (forwardable)
 * filter gets the plain traces list, which is honest: an unfiltered rule
 * evaluates every trace.
 */
export function ruleTracesUrl(params: {
  projectId: string;
  filter: FilterState;
}): string {
  const filter = ruleFilterToTraceFilter(params.filter);
  const base = `/project/${encodeURIComponent(params.projectId)}/traces`;

  return filter.length === 0
    ? base
    : `${base}?filter=${encodeURIComponent(encodeFiltersGeneric(filter))}`;
}

/**
 * `/scores` filtered to the score names this rule's runs wrote. Same shape as the
 * evaluator link (see `scoreNamesScoresUrl`), including the optional
 * environment condition: a rule filter of `environment any of [...]` is carried
 * over because an eval score inherits the environment of the trace it evaluated.
 */
export function ruleScoresUrl(params: {
  projectId: string;
  scoreNames: string[];
  filter?: FilterState;
}): string | null {
  const environments = (params.filter ?? []).flatMap((condition) =>
    condition.column === "environment" &&
    condition.type === "stringOptions" &&
    condition.operator === "any of"
      ? condition.value
      : [],
  );

  return scoreNamesScoresUrl({
    projectId: params.projectId,
    scoreNames: params.scoreNames,
    environments,
  });
}
