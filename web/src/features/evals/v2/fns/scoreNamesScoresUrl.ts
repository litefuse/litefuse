// ── LITEFUSE ADDITION — "/scores filtered to these score names" ──────────────
//
// Shared by the evaluators and rules tables: both link to "the scores this
// entity produced", and both know the names, not a column the scores surface
// could filter on. (`/scores` has no `evaluatorId`/`ruleId` filter column — the
// ownership lives in `scores.metadata`, which is not exposed as a filter — so the
// distinct names are the only honest filter.)
//
// The names are read from Doris per entity (see `getScoreNamesByOwnerKey`), so
// they are real: an evaluator whose decision model writes three scores
// (`… / choice`, `… / score`, `… / boolean (noul)`) yields all three.
// ─────────────────────────────────────────────────────────────────────────────

import {
  encodeFiltersGeneric,
  type FilterState,
  MAX_URL_FILTER_QUERY_LENGTH,
} from "@langfuse/shared";

/**
 * How much of the query string a names filter may use. Stays clear of
 * `MAX_URL_FILTER_QUERY_LENGTH`, past which the scores page deliberately
 * degrades to "no filter" — which would silently turn a precise link into a link
 * to *all* scores, the exact failure this whole change removes.
 */
const FILTER_BUDGET = MAX_URL_FILTER_QUERY_LENGTH - 500;

/**
 * The `/scores` URL for these names, or `null` when the filter cannot be built
 * (no names, or a single name too long to fit). Callers treat `null` as "no link"
 * and must not navigate — a scores page filtered on nothing is worse than no
 * link at all.
 *
 * Names arrive newest-first by row count (the repository orders by
 * `COUNT(*) DESC`), so when the budget forces a cut it drops the rarest names
 * rather than an arbitrary tail.
 */
export function scoreNamesScoresUrl(params: {
  projectId: string;
  scoreNames: string[];
  environments?: string[];
}): string | null {
  const names = [...new Set(params.scoreNames)].filter(Boolean);
  if (names.length === 0) return null;

  const environmentCondition: FilterState = params.environments?.length
    ? [
        {
          column: "environment",
          type: "stringOptions",
          operator: "any of",
          value: [...new Set(params.environments)],
        },
      ]
    : [];

  const build = (selectedNames: string[]): string => {
    const filter: FilterState = [
      // Eval scores are written with `source = "EVAL"`; keeping the condition
      // makes the link exclude same-named annotation scores.
      {
        column: "source",
        type: "stringOptions",
        operator: "any of",
        value: ["EVAL"],
      },
      {
        column: "name",
        type: "stringOptions",
        operator: "any of",
        value: selectedNames,
      },
      ...environmentCondition,
    ] satisfies FilterState;

    return `/project/${encodeURIComponent(params.projectId)}/scores?showAllEnvironments=true&filter=${encodeURIComponent(encodeFiltersGeneric(filter))}`;
  };

  const full = build(names);
  if (full.length <= FILTER_BUDGET) return full;

  for (let take = names.length - 1; take >= 1; take--) {
    const candidate = build(names.slice(0, take));
    if (candidate.length <= FILTER_BUDGET) return candidate;
  }

  return null;
}
