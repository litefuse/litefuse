import {
  type EvalTemplateType,
  EvalTemplateTypeEnum,
  type FilterState,
  LangfuseInternalTraceEnvironment,
  encodeFiltersGeneric,
} from "@langfuse/shared";

import { scoreNamesScoresUrl } from "../scoreNamesScoresUrl";

/**
 * "View scores" on an evaluator: the scores THIS evaluator wrote.
 *
 * The names are real, read from Doris by `metadata['evaluator_id']` (see
 * `getScoreNamesByEvaluatorIds`), and that matters most for decision models: the
 * evaluator's own name is NOT a score name there. One decision model writes one
 * score per question, so `ZZ jev flow — 2026-10-13` produced
 * `… / choice`, `… / score` and `… / boolean (noul)` — a name filter built from
 * the evaluator name would find nothing, and an `evaluatorId` filter is not a
 * column on the scores surface at all.
 *
 * Returns `null` when there is nothing to filter on; the caller must leave the
 * action disabled rather than navigate to an unfiltered scores list.
 */
export function evaluatorScoresUrl(params: {
  projectId: string;
  scoreNames: string[];
}): string | null {
  return scoreNamesScoresUrl(params);
}

export function evaluatorExecutionsUrl(
  projectId: string,
  evaluatorName: string,
  evaluatorType: EvalTemplateType,
) {
  const environment =
    evaluatorType === EvalTemplateTypeEnum.CODE
      ? LangfuseInternalTraceEnvironment.CodeEval
      : LangfuseInternalTraceEnvironment.LLMJudge;
  const filter: FilterState = [
    {
      column: "traceName",
      type: "stringOptions",
      operator: "any of",
      value: [`Execute evaluator: ${evaluatorName}`],
    },
    {
      column: "environment",
      type: "stringOptions",
      operator: "any of",
      value: [environment],
    },
    {
      column: "isRootObservation",
      type: "boolean",
      operator: "=",
      value: true,
    },
  ];
  return `/project/${encodeURIComponent(projectId)}/traces?filter=${encodeURIComponent(encodeFiltersGeneric(filter))}`;
}
