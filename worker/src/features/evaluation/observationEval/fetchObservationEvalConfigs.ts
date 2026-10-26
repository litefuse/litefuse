import {
  EvalTargetObject,
  JobConfigState,
  coerceLegacyEmptyMetadataFilters,
  normalizeEvaluationRuleTarget,
  type FilterState,
} from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import {
  logger,
  hasNoEvalConfigsCache,
  setNoEvalConfigsCache,
} from "@langfuse/shared/src/server";
import { type ObservationEvalConfig, type ObservationEvalRule } from "./types";

/**
 * Fetches the runnable observation evaluation rules for a project.
 *
 * ── LITEFUSE ADDITION (evaluators v2) ───────────────────────────────────────
 * Returns both sources the scheduler can run:
 *   * v2 `evaluation_rules` targeting EVENT/EXPERIMENT (the migrated model), and
 *   * legacy `job_configurations` targeting EVENT/EXPERIMENT (still reachable
 *     through manual batch jobs).
 * Upstream only fetches rules; the legacy query is kept here so existing
 * observation configurations keep evaluating during the migration.
 *
 * The v2 query stays as narrow as possible because it runs per ingested
 * observation: inactive rules and blocked evaluators are excluded in SQL, and
 * evaluator versions are not joined at all — dispatch only needs the evaluator's
 * identity and type, and the executor resolves the definition when it picks the
 * job up.
 *
 * Uses a cache to avoid unnecessary database queries:
 * - If cached as "no configs", returns empty array immediately
 * - If cache miss, queries database and caches result if empty
 *
 * @param projectId - The project ID to fetch rules for
 * @returns Array of runnable observation eval rules (empty if none exist)
 */
export async function fetchObservationEvalConfigs(
  projectId: string,
): Promise<ObservationEvalRule[]> {
  // Check cache first
  const hasNoConfigs = await hasNoEvalConfigsCache(projectId, "eventBased");
  if (hasNoConfigs) {
    logger.debug(
      `Skipping observation eval config fetch - no configs cached for project ${projectId}`,
    );

    return [];
  }

  const [configs, rules] = await Promise.all([
    fetchLegacyConfigs(projectId),
    fetchEvaluationRules(projectId),
  ]);

  const all: ObservationEvalRule[] = [...configs, ...rules];

  // Cache if nothing runnable was found
  if (all.length === 0) {
    logger.debug(
      `No observation eval configs found for project ${projectId}, caching`,
    );
    await setNoEvalConfigsCache(projectId, "eventBased");

    return [];
  }

  logger.debug(
    `Found ${configs.length} legacy config(s) and ${rules.length} evaluation rule(s) for project ${projectId}`,
  );

  return all;
}

/** Legacy `job_configurations` with an observation/experiment target. */
async function fetchLegacyConfigs(
  projectId: string,
): Promise<ObservationEvalConfig[]> {
  return prisma.jobConfiguration.findMany({
    where: {
      projectId,
      targetObject: {
        in: [EvalTargetObject.EVENT, EvalTargetObject.EXPERIMENT],
      },
      status: JobConfigState.ACTIVE,
      blockedAt: null,
    },
    select: {
      id: true,
      projectId: true,
      filter: true,
      sampling: true,
      evalTemplateId: true,
      scoreName: true,
      status: true,
      blockedAt: true,
      targetObject: true,
      variableMapping: true,
    },
  });
}

/** v2 `evaluation_rules` with an observation/experiment target. */
async function fetchEvaluationRules(projectId: string) {
  const rules = await prisma.evaluationRule.findMany({
    where: {
      projectId,
      targetObject: {
        in: [EvalTargetObject.EVENT, EvalTargetObject.EXPERIMENT],
      },
      status: JobConfigState.ACTIVE,
      // A rule whose every evaluator is blocked schedules nothing, so it must not
      // keep the project out of the "no rules" cache above.
      assignments: { some: { projectId, evaluator: { blockedAt: null } } },
    },
    select: {
      id: true,
      projectId: true,
      filter: true,
      sampling: true,
      status: true,
      targetObject: true,
      assignments: {
        where: { projectId, evaluator: { blockedAt: null } },
        select: {
          id: true,
          evaluatorId: true,
          variableMapping: true,
          evaluator: {
            select: { id: true, projectId: true, type: true },
          },
        },
      },
    },
  });

  // Canonicalize here so the scheduler only ever sees `event` rules: the legacy
  // `experiment` target is expressed as its root-span filter instead.
  return rules.map((rule) => {
    const normalized = normalizeEvaluationRuleTarget({
      targetObject: rule.targetObject as
        | typeof EvalTargetObject.EVENT
        | typeof EvalTargetObject.EXPERIMENT,
      filter: coerceLegacyEmptyMetadataFilters(rule.filter) as FilterState,
    });

    return { ...rule, ...normalized, ruleId: rule.id };
  });
}
