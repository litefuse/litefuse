// ── LITEFUSE ADDITION (evaluators v2 score persistence) ─────────────────────
// One place that turns a v2 execution result into persisted scores, shared by the
// LLM-as-a-judge executor (`v2LlmEvaluatorExecution.ts`) and the decision-model
// executor (`v2DecisionModelExecution.ts`).
//
// The legacy path (`executeLLMAsJudgeEvaluation`) keeps its own numeric-only
// writer; this module only serves v2 executions, which can emit NUMERIC, BOOLEAN
// and CATEGORICAL scores (a categorical or multi-question decision model emits
// several scores per execution).
//
// Deviation from upstream: our ingestion score body has no `evaluatorId` /
// `evaluationRuleId` fields (upstream added them to the body), and the body's
// `configId` is reserved for legacy score configs. The v2 identity is therefore
// carried in the score `metadata` (`evaluation_rule_id` + the execution
// metadata).
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import { JobExecutionStatus, type JobExecution } from "@prisma/client";
import { ScoreSourceEnum } from "@langfuse/shared";
import {
  eventTypes,
  logger,
  traceException,
  type ScoreEventType,
} from "@langfuse/shared/src/server";
import { type EvalExecutionDeps } from "./evalExecutionDeps";

/** A score a v2 execution wants persisted. */
export type V2ScoreData = {
  name: string;
  value: number | string;
  dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
  comment?: string | null;
  /**
   * Set for evaluator runs: the evaluation rule id. Recorded in the score
   * metadata as `evaluation_rule_id` — never in the body's `configId`, which
   * means a legacy score config id to the ingestion service.
   */
  configId?: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Builds the score-create event for one v2 score.
 *
 * Kept pure and exported so tests can validate the payload against the ingestion
 * contract (`ScoreBody`) for every data type.
 */
export function buildV2ScoreEvent(params: {
  eventId: string;
  scoreId: string;
  score: V2ScoreData;
  job: Pick<JobExecution, "jobInputTraceId" | "jobInputObservationId">;
  environment: string;
  executionTraceId: string;
  metadata: Record<string, string>;
}): ScoreEventType {
  const { score } = params;

  const body = {
    id: params.scoreId,
    traceId: params.job.jobInputTraceId,
    observationId: params.job.jobInputObservationId,
    name: score.name,
    comment: score.comment ?? null,
    source: ScoreSourceEnum.EVAL,
    environment: params.environment,
    executionTraceId: params.executionTraceId,
    metadata: {
      ...(score.metadata ?? {}),
      ...params.metadata,
      // The rule id cannot go into the body's `configId` (see below), so it is
      // recorded here to keep scores traceable back to the rule that produced
      // them.
      ...(score.configId ? { evaluation_rule_id: score.configId } : {}),
    },
    dataType: score.dataType,
    // MUST stay null: in the ingestion contract `configId` means a legacy
    // *score config* id. `validateAndInflateScore` looks it up in score_configs
    // and throws LangfuseNotFoundError for anything else — and the ingestion
    // service catches that per score, silently dropping it, which surfaces only
    // as "No records to merge" on the queue job while the job execution is still
    // marked COMPLETED. The v2 identity (rule, evaluator, version) travels in
    // `metadata` instead, which our score body does not validate against configs.
    configId: null,
    // Our score contract types `value` per data type (number for NUMERIC/BOOLEAN,
    // string for CATEGORICAL), which `number | string` cannot express; the
    // discriminant is `dataType` and the ingestion schema validates the pairing.
    value: score.value,
  } as ScoreEventType["body"];

  return {
    id: params.eventId,
    timestamp: new Date().toISOString(),
    type: eventTypes.SCORE_CREATE,
    body,
  };
}

/**
 * Uploads and enqueues every score of one execution, then marks the job
 * COMPLETED with the first score as its primary output.
 *
 * Returns the persisted score ids in order.
 */
export async function persistV2Scores(params: {
  deps: EvalExecutionDeps;
  projectId: string;
  jobExecutionId: string;
  job: Pick<JobExecution, "jobInputTraceId" | "jobInputObservationId">;
  scores: V2ScoreData[];
  environment: string;
  executionTraceId: string;
  metadata: Record<string, string>;
}): Promise<{ scoreIds: string[] }> {
  const {
    deps,
    projectId,
    jobExecutionId,
    job,
    scores,
    environment,
    executionTraceId,
    metadata,
  } = params;

  if (scores.length === 0) {
    throw new Error(`Evaluation job ${jobExecutionId} produced no scores`);
  }

  const scoreIds: string[] = [];
  for (const score of scores) {
    const eventId = randomUUID();
    const scoreId = randomUUID();
    scoreIds.push(scoreId);

    try {
      await deps.uploadScore({
        projectId,
        scoreId,
        eventId,
        event: buildV2ScoreEvent({
          eventId,
          scoreId,
          score,
          job,
          environment,
          executionTraceId,
          metadata,
        }),
      });

      await deps.enqueueScoreIngestion({ projectId, scoreId, eventId });
    } catch (e) {
      logger.error(`Failed to persist score: ${e}`, e);
      traceException(e);
      throw new Error(`Failed to write score ${scoreId} into IngestionQueue`);
    }
  }

  const [primaryScoreId] = scoreIds;
  await deps.updateJobExecution({
    id: jobExecutionId,
    projectId,
    data: {
      status: JobExecutionStatus.COMPLETED,
      endTime: new Date(),
      jobOutputScoreId: primaryScoreId,
      executionTraceId,
    },
  });

  logger.debug(
    `Persisted ${scoreIds.length} score(s) for evaluation job ${jobExecutionId}`,
  );

  return { scoreIds };
}
