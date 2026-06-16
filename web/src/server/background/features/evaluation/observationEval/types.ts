import {
  type JobConfiguration,
  type JobExecutionStatus,
} from "@langfuse/shared/src/db";

/**
 * Re-export ObservationForEval as the canonical observation type for eval operations.
 * This type is used for both filtering and variable extraction.
 *
 * @see packages/shared/src/features/evals/observationForEval.ts for schema definition
 */
export {
  type ObservationForEval,
  observationForEvalSchema,
  observationEvalFilterColumns,
  observationEvalVariableColumns,
} from "@langfuse/shared";

/**
 * Observation eval job configuration.
 * Represents a job configuration with targetObject: "event".
 * Passed to the scheduler after being fetched once per batch.
 */
export type ObservationEvalConfig = Pick<
  JobConfiguration,
  | "id"
  | "projectId"
  | "filter"
  | "sampling"
  | "evalTemplateId"
  | "scoreName"
  | "targetObject"
  | "variableMapping"
  | "status"
  | "blockedAt"
>;

/**
 * Dependencies for scheduling observation evals.
 * The scheduler receives pre-fetched configs and creates job executions.
 */
export interface ObservationEvalSchedulerDeps {
  /** Create a job execution record in the database */
  upsertJobExecution: (params: {
    id: string;
    projectId: string;
    jobConfigurationId: string;
    jobInputTraceId: string;
    jobInputObservationId: string | null;
    jobTemplateId: string | null;
    status: JobExecutionStatus;
  }) => Promise<{ id: string }>;

  /**
   * Enqueue the eval job for execution. Payload carries the Doris
   * coordinates (spanId + startTimeDate partition key); the eval
   * processor re-reads events_full at run time. There is no S3
   * upload step here — Doris is the source of truth.
   */
  enqueueEvalJob: (params: {
    jobExecutionId: string;
    projectId: string;
    spanId: string;
    startTimeDate: string;
    delay: number;
    targetObject: string;
  }) => Promise<void>;
}
