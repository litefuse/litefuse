// ── LITEFUSE ADDITION — server side of the evals v2 "View traces / scores" links
//
// Both tables "View traces" / "View scores" deep links need a fact that lives
// outside the row itself:
//
//   * rule "View traces"        → the rule's own filter (already on the row)
//   * evaluator "View traces"   → the filters of the rules it is attached to
//     (the evaluator has no filter of its own — it is *mounted* by rules)
//   * rule "View scores"        → the distinct score names its runs wrote
//   * evaluator "View scores"   → the distinct score names it wrote
//
// The last two come from Doris (`getScoreNamesByOwnerKey`, keyed on the
// `evaluator_id` / `evaluation_rule_id` metadata the executors stamp), the
// evaluator's rules come from Postgres. Both lookups are batched over the ids of
// one page, so rendering a table costs one Postgres query and one Doris query,
// not one per row.
//
// Nothing here is written: the module is a read-only projection used by the two
// `linkTargets` procedures (evaluators/linkTargets, evaluators.rules/linkTargets).
// ─────────────────────────────────────────────────────────────────────────────

import type { FilterState } from "@langfuse/shared";
import {
  getScoreNamesByEvaluatorIds,
  getScoreNamesByRuleIds,
} from "@langfuse/shared/src/server";
import type { PrismaClient } from "@langfuse/shared/src/db";

/** A rule an evaluator is attached to, reduced to what a traces link needs. */
export type EvaluatorRuleTarget = {
  id: string;
  name: string;
  filter: FilterState;
  active: boolean;
};

export type EvaluatorLinkTargets = {
  scoreNames: string[];
  rules: EvaluatorRuleTarget[];
};

export type RuleLinkTargets = {
  scoreNames: string[];
};

/**
 * Score names produced by these evaluators, plus the rules each is attached to.
 * Evaluators with nothing to link to map to empty arrays rather than being
 * omitted, so a caller can tell "no data yet" from "not requested".
 */
export async function getEvaluatorLinkTargets(params: {
  prisma: PrismaClient;
  projectId: string;
  evaluatorIds: string[];
}): Promise<Record<string, EvaluatorLinkTargets>> {
  const evaluatorIds = [...new Set(params.evaluatorIds)].filter(Boolean);

  const result: Record<string, EvaluatorLinkTargets> = {};
  for (const evaluatorId of evaluatorIds) {
    result[evaluatorId] = { scoreNames: [], rules: [] };
  }
  if (evaluatorIds.length === 0) return result;

  const [scoreNamesByEvaluator, assignments] = await Promise.all([
    getScoreNamesByEvaluatorIds({
      projectId: params.projectId,
      evaluatorIds,
    }),
    params.prisma.evaluationRuleEvaluatorAssignment.findMany({
      where: {
        projectId: params.projectId,
        evaluatorId: { in: evaluatorIds },
        evaluator: { projectId: params.projectId },
        evaluationRule: { projectId: params.projectId },
      },
      orderBy: { createdAt: "desc" },
      select: {
        evaluatorId: true,
        evaluationRule: {
          select: { id: true, name: true, status: true, filter: true },
        },
      },
    }),
  ]);

  for (const evaluatorId of evaluatorIds) {
    result[evaluatorId] = {
      scoreNames: scoreNamesByEvaluator.get(evaluatorId) ?? [],
      rules: [],
    };
  }

  const seen = new Set<string>();
  for (const assignment of assignments) {
    const target = result[assignment.evaluatorId];
    if (!target) continue;
    // A rule can only be attached to an evaluator once (unique constraint), but
    // a duplicate row would otherwise put the same rule in the traces menu
    // twice; the menu is small and duplicates are worse than a cheap guard.
    const key = `${assignment.evaluatorId}:${assignment.evaluationRule.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    target.rules.push({
      id: assignment.evaluationRule.id,
      name: assignment.evaluationRule.name,
      // Stored as JSON; the column is validated by `singleFilterList` on write,
      // so the cast is the same one `listRulesForEvaluator` makes.
      filter: assignment.evaluationRule.filter as FilterState,
      active: assignment.evaluationRule.status === "ACTIVE",
    });
  }

  return result;
}

/** Score names produced by these rules' runs. */
export async function getRuleLinkTargets(params: {
  projectId: string;
  ruleIds: string[];
}): Promise<Record<string, RuleLinkTargets>> {
  const ruleIds = [...new Set(params.ruleIds)].filter(Boolean);

  const result: Record<string, RuleLinkTargets> = {};
  for (const ruleId of ruleIds) result[ruleId] = { scoreNames: [] };
  if (ruleIds.length === 0) return result;

  const scoreNamesByRule = await getScoreNamesByRuleIds({
    projectId: params.projectId,
    ruleIds,
  });

  for (const ruleId of ruleIds) {
    result[ruleId] = {
      scoreNames: scoreNamesByRule.get(ruleId) ?? [],
    };
  }

  return result;
}
