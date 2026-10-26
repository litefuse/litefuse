// ── LITEFUSE ADDITION — read side of the "View scores" deep links ───────────
// The evaluators v2 / rules v2 tables need to answer one question each before
// they can link anywhere honest:
//
//   * "which score names did THIS evaluator write?"   → `metadata['evaluator_id']`
//   * "which score names did THIS rule's runs write?" → `metadata['evaluation_rule_id']`
//
// Neither question is answerable from Postgres. `evaluators` and
// `evaluation_rules` hold the definition, not the output, and the score name is
// not derivable from the definition either: a decision-model evaluator writes
// ONE score per question, so the three question types produce three different
// names (`… / choice`, `… / score`, `… / boolean (noul)`) that carry no shared
// prefix beyond the evaluator's own display name. Only the rows themselves know.
// The metadata keys are what the v2 executors stamp on every score they write
// (worker/src/features/evaluation/v2LlmEvaluatorExecution.ts,
// v2DecisionModelExecution.ts), so the aggregation is the definition of "the
// scores this entity produced".
//
// Doris notes:
//   * `scores.metadata` is a `MAP<TEXT, TEXT>`, so a bare `metadata['k']` read is
//     already TEXT — no `CAST(… AS STRING)` needed here (that idiom belongs to
//     `spans.metadata`, which is a VARIANT).
//   * The map key is interpolated, not parameterised: Doris cannot bind a MAP
//     subscript, and a bound parameter inside `[…]` is not accepted. It is safe
//     because `EvalScoreOwnerKey` is a closed union and the SQL fragment comes
//     from `OWNER_KEY_SQL` below, never from a caller.
//   * `is_deleted = 0` matches what the scores surface shows, so a link never
//     filters on a name that only deleted rows carry.
//
// Bounded by construction: callers pass at most the ids of one page of the
// table (≤100, the ceiling the routers' zod schemas already enforce), the query
// groups by `(owner, name)` on the project's own split-free `scores` table, and
// `LIMIT` caps a pathological project at `MAX_SCORE_NAMES_PER_OWNER` names per
// owner instead of returning an unbounded list into a URL.
// ─────────────────────────────────────────────────────────────────────────────

import { queryDoris } from "./doris";

/**
 * The metadata keys this reader reads. A closed union on purpose: it is what
 * keeps the interpolated map subscript below non-injectable.
 */
export type EvalScoreOwnerKey = "evaluator_id" | "evaluation_rule_id";

/** The interpolated form of each supported key (see the file header). */
const OWNER_KEY_SQL: Record<EvalScoreOwnerKey, string> = {
  evaluator_id: "metadata['evaluator_id']",
  evaluation_rule_id: "metadata['evaluation_rule_id']",
};

/**
 * How many distinct score names one owner may contribute to a deep link. A
 * decision model writes one name per question (a handful); hundreds would mean
 * something is wrong, and a URL is not a place to find that out.
 */
const MAX_SCORE_NAMES_PER_OWNER = 25;

/** The Doris row this reader selects. */
type DorisScoreNameRow = {
  owner_id: string;
  name: string;
  score_count: number | string;
};

/**
 * Distinct score names per owner, newest-first-by-count, as a map keyed by the
 * owner id. Owners with no rows are absent (callers treat missing as "none"),
 * so a link is only built when the names are real.
 */
export async function getScoreNamesByOwnerKey(params: {
  projectId: string;
  ownerKey: EvalScoreOwnerKey;
  ownerIds: string[];
}): Promise<Map<string, string[]>> {
  const ownerIds = [...new Set(params.ownerIds)].filter(Boolean);
  if (ownerIds.length === 0) return new Map();

  const ownerExpression = OWNER_KEY_SQL[params.ownerKey];

  const query = `
    SELECT
      ${ownerExpression} AS owner_id,
      name,
      COUNT(*) AS score_count
    FROM scores
    WHERE project_id = {projectId: String}
      AND is_deleted = 0
      AND ${ownerExpression} IS NOT NULL
      AND ${ownerExpression} IN ({ownerIds: Array(String)})
    GROUP BY ${ownerExpression}, name
    ORDER BY owner_id ASC, score_count DESC, name ASC
  `;

  const rows = await queryDoris<DorisScoreNameRow>({
    query,
    params: { projectId: params.projectId, ownerIds },
    tags: {
      feature: "evals",
      type: "score-names",
      kind: "analytic",
      projectId: params.projectId,
    },
  });

  const namesByOwner = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.owner_id || typeof row.name !== "string" || row.name === "") {
      continue;
    }
    const names = namesByOwner.get(row.owner_id) ?? [];
    if (names.length >= MAX_SCORE_NAMES_PER_OWNER) continue;
    names.push(row.name);
    namesByOwner.set(row.owner_id, names);
  }

  return namesByOwner;
}

/** Score names written by each of these evaluators (see the file header). */
export function getScoreNamesByEvaluatorIds(params: {
  projectId: string;
  evaluatorIds: string[];
}): Promise<Map<string, string[]>> {
  return getScoreNamesByOwnerKey({
    projectId: params.projectId,
    ownerKey: "evaluator_id",
    ownerIds: params.evaluatorIds,
  });
}

/** Score names written by the runs of each of these rules. */
export function getScoreNamesByRuleIds(params: {
  projectId: string;
  ruleIds: string[];
}): Promise<Map<string, string[]>> {
  return getScoreNamesByOwnerKey({
    projectId: params.projectId,
    ownerKey: "evaluation_rule_id",
    ownerIds: params.ruleIds,
  });
}
