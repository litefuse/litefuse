import { z } from "zod/v4";
import { eventTypes } from "./ingestion/types";
import {
  ActionId,
  BatchActionQuerySchema,
  BatchActionType,
} from "../features/batchAction/types";
import { BatchTableNames } from "../interfaces/tableNames";
import { EventActionSchema } from "../domain";
import { PromptDomainSchema } from "../domain/prompts";
import { ObservationAddToDatasetConfigSchema } from "../features/batchAction/addToDatasetTypes";
import { EvalTargetObjectSchema } from "../features/evals/types";
// LITEFUSE ADDITION: the observation execution event carries the v2 identity and
// the mode, so the worker can resolve an evaluator without guessing from ids.
import {
  BatchEvalEvaluatorMappingSchema,
  observationVariableMappingList,
} from "../features/evals/types";
import { EvalExecutionMode } from "../features/evals/evalConfigBlocking";

export const IngestionEvent = z.object({
  data: z.object({
    type: z.enum(Object.values(eventTypes)),
    eventBodyId: z.string(),
    fileKey: z.string().optional(),
    skipS3List: z.boolean().optional(),
    forwardToEventsTable: z.boolean().optional(),
  }),
  authCheck: z.object({
    validKey: z.literal(true),
    scope: z.object({
      projectId: z.string(),
    }),
  }),
});

export const OtelIngestionEvent = z.object({
  data: z.object({
    fileKey: z.string(),
    publicKey: z.string().optional(),
  }),
  authCheck: z.object({
    validKey: z.literal(true),
    scope: z.object({
      projectId: z.string(),
      accessLevel: z.literal("project"),
      orgId: z.string().optional(),
    }),
  }),
  propagatedHeaders: z.record(z.string(), z.string()).optional(),
  sdkName: z.string().optional(),
  sdkVersion: z.string().optional(),
  ingestionVersion: z.string().optional(),
});

/**
 * One registered otel file awaiting grouping (exactly-once pipeline): the
 * entry web RPUSHes into the per-shard pending list, carried verbatim through
 * the grouper's staging record into the group job payload. `size`
 * (source bytes) and `spanCount` drive group sizing; the auth/SDK metadata
 * mirrors what the legacy per-file job payload carried.
 */
export const OtelPendingEntry = z.object({
  v: z.literal(1),
  fileKey: z.string(),
  size: z.number(),
  spanCount: z.number(),
  /** Registration epoch-ms — drives the grouper's flush-timeout decision. */
  ts: z.number(),
  projectId: z.string(),
  publicKey: z.string().optional(),
  orgId: z.string().optional(),
  sdkName: z.string().optional(),
  sdkVersion: z.string().optional(),
  ingestionVersion: z.string().optional(),
  propagatedHeaders: z.record(z.string(), z.string()).optional(),
});
export type OtelPendingEntryType = z.infer<typeof OtelPendingEntry>;

/**
 * Group-shaped otel ingestion job (exactly-once pipeline): one job = one
 * group = one spans stream load batch = one deterministic label.
 * `shape` is the version gate — workers route on it and old workers fail
 * loudly instead of misreading the payload. jobId MUST equal groupId
 * (= sha1 of the sorted member fileKeys) so replays dedup in BullMQ and the
 * derived load label stays stable.
 */
export const OtelGroupIngestionEvent = z.object({
  shape: z.literal("group-v1"),
  groupId: z.string(),
  entries: z.array(OtelPendingEntry),
});
export type OtelGroupIngestionEventType = z.infer<
  typeof OtelGroupIngestionEvent
>;

export const BatchExportJobSchema = z.object({
  projectId: z.string(),
  batchExportId: z.string(),
});
export const TraceQueueEventSchema = z.object({
  projectId: z.string(),
  traceId: z.string(),
  exactTimestamp: z.date().optional(),
  traceEnvironment: z.string().optional(), // Optional to maintain backward compatibility with existing jobs in queue during deployment. 'optional()' can be removed after queue was exhausted
});
export const TracesQueueEventSchema = z.object({
  projectId: z.string(),
  traceIds: z.array(z.string()),
});
export const ScoresQueueEventSchema = z.object({
  projectId: z.string(),
  scoreIds: z.array(z.string()),
});
export const DatasetQueueEventSchema = z.discriminatedUnion("deletionType", [
  // Delete all run items for a specific dataset
  z.object({
    deletionType: z.literal("dataset"),
    projectId: z.string(),
    datasetId: z.string(),
  }),
  // Delete all run items for multiple dataset runs (also used for single run deletion)
  z.object({
    deletionType: z.literal("dataset-runs"),
    projectId: z.string(),
    datasetId: z.string(),
    datasetRunIds: z.array(z.string()),
  }),
]);
export const ProjectQueueEventSchema = z.object({
  projectId: z.string(),
  orgId: z.string(),
});
export const DatasetRunItemUpsertEventSchema = z.object({
  projectId: z.string(),
  datasetItemId: z.string(),
  datasetItemValidFrom: z.date().optional(), // Exact valid_from value from DB (internally controlled)
  traceId: z.string(),
  observationId: z.string().optional(),
});
export const EvalExecutionEvent = z.object({
  projectId: z.string(),
  jobExecutionId: z.string(),
  delay: z.number().nullish(),
  // ── LITEFUSE ADDITION (copied from upstream) ──────────────────────────────
  // Evaluator v2 identity, carried by newly scheduled trace/dataset jobs so the
  // worker does not have to re-derive which evaluator a job belongs to from
  // `jobConfigurationId`. Jobs queued before the migration omit both fields;
  // their `job_configuration_id` is the migrated rule id, which the worker
  // resolves directly.
  evaluatorId: z.string().optional(),
  evaluationRuleId: z.string().optional(),
});

// LLM-as-a-Judge execution for observation-based evals
export const LLMAsJudgeExecutionEventSchema = z.object({
  projectId: z.string(),
  jobExecutionId: z.string(),
  observationS3Path: z.string(),
  // ── LITEFUSE ADDITIONS (copied from upstream's ObservationEvalExecutionEvent) ─
  // Evaluator v2 identity, carried so the worker does not have to re-derive which
  // evaluator a job belongs to from `jobConfigurationId`: the legacy backfill
  // reuses job-configuration ids for both rules and evaluators, so that id alone
  // is ambiguous. Absent on jobs queued before evaluator v2; the worker resolves
  // those through the migrated rule assignment.
  //
  // No version is carried: a rule always runs its evaluator's current version,
  // which the executor resolves on pickup and records on the execution.
  executionMode: EvalExecutionMode.optional(),
  evaluatorId: z.string().optional(),
  evaluationRuleId: z.string().optional(),
  // Ruleless manual batch runs have no assignment row to hold a mapping override.
  // Optional for jobs queued before this field existed; those inherit the
  // evaluator version mapping.
  variableMapping: observationVariableMappingList.optional(),
});
export const PostHogIntegrationProcessingEventSchema = z.object({
  projectId: z.string(),
});
export const MixpanelIntegrationProcessingEventSchema = z.object({
  projectId: z.string(),
});
export const BlobStorageIntegrationProcessingEventSchema = z.object({
  projectId: z.string(),
});
export const ExperimentCreateEventSchema = z.object({
  projectId: z.string(),
  datasetId: z.string(),
  runId: z.string(),
  description: z.string().optional(),
});
export const BatchActionProcessingEventSchema = z.discriminatedUnion(
  "actionId",
  [
    z.object({
      actionId: z.literal("score-delete"),
      projectId: z.string(),
      query: BatchActionQuerySchema,
      tableName: z.enum(BatchTableNames),
      cutoffCreatedAt: z.date(),
      targetId: z.string().optional(),
      type: z.enum(BatchActionType),
    }),
    z.object({
      actionId: z.literal("trace-delete"),
      projectId: z.string(),
      query: BatchActionQuerySchema,
      tableName: z.enum(BatchTableNames),
      cutoffCreatedAt: z.date(),
      targetId: z.string().optional(),
      type: z.enum(BatchActionType),
    }),
    z.object({
      actionId: z.literal("trace-add-to-annotation-queue"),
      projectId: z.string(),
      query: BatchActionQuerySchema,
      tableName: z.enum(BatchTableNames),
      cutoffCreatedAt: z.date(),
      targetId: z.string().optional(),
      type: z.enum(BatchActionType),
    }),
    z.object({
      actionId: z.literal("session-add-to-annotation-queue"),
      projectId: z.string(),
      query: BatchActionQuerySchema,
      tableName: z.enum(BatchTableNames),
      cutoffCreatedAt: z.date(),
      targetId: z.string().optional(),
      type: z.enum(BatchActionType),
    }),
    z.object({
      actionId: z.literal("observation-add-to-annotation-queue"),
      projectId: z.string(),
      query: BatchActionQuerySchema,
      tableName: z.enum(BatchTableNames),
      cutoffCreatedAt: z.date(),
      targetId: z.string().optional(),
      type: z.enum(BatchActionType),
    }),
    z.object({
      actionId: z.literal("eval-create"),
      targetObject: EvalTargetObjectSchema,
      configId: z.string(),
      projectId: z.string(),
      cutoffCreatedAt: z.date(),
      query: BatchActionQuerySchema,
    }),
    z.object({
      actionId: z.literal("observation-add-to-dataset"),
      projectId: z.string(),
      query: BatchActionQuerySchema,
      tableName: z.enum(BatchTableNames),
      cutoffCreatedAt: z.date(),
      batchActionId: z.string(),
      config: ObservationAddToDatasetConfigSchema,
      type: z.enum(BatchActionType),
    }),
    z.object({
      actionId: z.literal(ActionId.ObservationBatchEvaluation),
      projectId: z.string(),
      query: BatchActionQuerySchema,
      cutoffCreatedAt: z.date(),
      batchActionId: z.string(),
      evaluatorIds: z.array(z.string()),
      // ── LITEFUSE ADDITIONS (copied from upstream) ─────────────────────────
      // Which id space `evaluatorIds` refers to. `"v2"` means the ids are
      // `evaluators` rows (the migrated model); absent means the legacy
      // `job_configurations` ids a pre-migration producer sent.
      evalVersion: z.literal("v2").optional(),
      /**
       * Per-evaluator mapping override, for a one-shot batch run. A `null`
       * mapping inherits the evaluator version's mapping.
       */
      evaluatorMappings: z.array(BatchEvalEvaluatorMappingSchema).optional(),
      /**
       * Fraction of the selected rows to evaluate (0..1). Absent means "every
       * selected row" — which is what a plain legacy producer means. The v2
       * backfill dialog sends the fraction the user picked in the cost dialog;
       * before this field existed the worker forced 1 and silently ignored it.
       */
      sampling: z.number().min(0).max(1).optional(),
      /**
       * Cap on how many rows are read for this run. Absent means the instance
       * ceiling (`LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT`); a caller can only
       * lower that, never raise it.
       */
      rowLimit: z.number().int().positive().optional(),
    }),
  ],
);

export const CreateEvalQueueEventSchema = DatasetRunItemUpsertEventSchema.and(
  z.object({
    configId: z.string(),
    timestamp: z.date(),
  }),
).or(
  TraceQueueEventSchema.and(
    z.object({
      timestamp: z.date(),
      configId: z.string(),
      exactTimestamp: z.date().optional(),
    }),
  ),
);

export const DeadLetterRetryQueueEventSchema = z.object({
  timestamp: z.date(),
});

export const NotificationEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("COMMENT_MENTION"),
    commentId: z.string(),
    projectId: z.string(),
    mentionedUserIds: z.array(z.string()),
  }),
  // Future notification types can be added here
]);

export const WebhookOutboundEnvelopeSchema = z.object({
  prompt: PromptDomainSchema,
  action: EventActionSchema,
  type: z.literal("prompt-version"),
  user: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
    })
    .optional(),
});

export const WebhookInputSchema = z.object({
  projectId: z.string(),
  automationId: z.string(),
  executionId: z.string(),
  payload: WebhookOutboundEnvelopeSchema,
});

export type WebhookInput = z.infer<typeof WebhookInputSchema>;
export const EntityChangeEventSchema = z.discriminatedUnion("entityType", [
  z.object({
    entityType: z.literal("prompt-version"),
    projectId: z.string(),
    promptId: z.string(),
    action: EventActionSchema,
    prompt: PromptDomainSchema,
    user: z
      .object({
        id: z.string(),
        name: z.string().nullable(),
        email: z.string().nullable(),
      })
      .optional(),
  }),
  // Add other entity types here in the future
]);
export type EntityChangeEventType = z.infer<typeof EntityChangeEventSchema>;

export type CreateEvalQueueEventType = z.infer<
  typeof CreateEvalQueueEventSchema
>;
export type BatchExportJobType = z.infer<typeof BatchExportJobSchema>;
export type TraceQueueEventType = z.infer<typeof TraceQueueEventSchema>;
export type TracesQueueEventType = z.infer<typeof TracesQueueEventSchema>;
export type ScoresQueueEventType = z.infer<typeof ScoresQueueEventSchema>;
export type DatasetQueueEventType = z.infer<typeof DatasetQueueEventSchema>;
export type ProjectQueueEventType = z.infer<typeof ProjectQueueEventSchema>;
export type DatasetRunItemUpsertEventType = z.infer<
  typeof DatasetRunItemUpsertEventSchema
>;
export type EvalExecutionEventType = z.infer<typeof EvalExecutionEvent>;
export type LLMAsJudgeExecutionEventType = z.infer<
  typeof LLMAsJudgeExecutionEventSchema
>;
export type IngestionEventQueueType = z.infer<typeof IngestionEvent>;
export type OtelIngestionEventQueueType = z.infer<typeof OtelIngestionEvent>;
export type ExperimentCreateEventType = z.infer<
  typeof ExperimentCreateEventSchema
>;
export type PostHogIntegrationProcessingEventType = z.infer<
  typeof PostHogIntegrationProcessingEventSchema
>;
export type MixpanelIntegrationProcessingEventType = z.infer<
  typeof MixpanelIntegrationProcessingEventSchema
>;
export type BatchActionProcessingEventType = z.infer<
  typeof BatchActionProcessingEventSchema
>;
export type BlobStorageIntegrationProcessingEventType = z.infer<
  typeof BlobStorageIntegrationProcessingEventSchema
>;
export type DeadLetterRetryQueueEventType = z.infer<
  typeof DeadLetterRetryQueueEventSchema
>;
export type NotificationEventType = z.infer<typeof NotificationEventSchema>;

export const RetryBaggage = z.object({
  originalJobTimestamp: z.date(),
  attempt: z.number(),
});

export type RetryBaggage = z.infer<typeof RetryBaggage>;

export enum QueueName {
  TraceUpsert = "trace-upsert", // Ingestion pipeline adds events on each Trace upsert
  TraceDelete = "trace-delete",
  ProjectDelete = "project-delete",
  EvaluationExecution = "evaluation-execution-queue", // Worker executes Evals
  EvaluationExecutionSecondaryQueue = "secondary-evaluation-execution-queue", // Separates high-throughput eval projects from other projects.
  LLMAsJudgeExecution = "llm-as-a-judge-execution-queue", // Observation-based eval execution
  DatasetRunItemUpsert = "dataset-run-item-upsert-queue",
  BatchExport = "batch-export-queue",
  OtelIngestionQueue = "otel-ingestion-queue",
  IngestionQueue = "ingestion-queue", // Process single events with S3-merge
  IngestionSecondaryQueue = "secondary-ingestion-queue", // Separates high priority + high throughput projects from other projects.
  CloudUsageMeteringQueue = "cloud-usage-metering-queue",
  CloudFreeTierUsageThresholdQueue = "cloud-free-tier-usage-threshold-queue",
  ExperimentCreate = "experiment-create-queue",
  PostHogIntegrationQueue = "posthog-integration-queue",
  PostHogIntegrationProcessingQueue = "posthog-integration-processing-queue",
  MixpanelIntegrationQueue = "mixpanel-integration-queue",
  MixpanelIntegrationProcessingQueue = "mixpanel-integration-processing-queue",
  BlobStorageIntegrationQueue = "blobstorage-integration-queue",
  BlobStorageIntegrationProcessingQueue = "blobstorage-integration-processing-queue",
  CoreDataS3ExportQueue = "core-data-s3-export-queue",
  BatchActionQueue = "batch-action-queue",
  CreateEvalQueue = "create-eval-queue",
  ScoreDelete = "score-delete",
  DatasetDelete = "dataset-delete-queue",
  DeadLetterRetryQueue = "dead-letter-retry-queue",
  WebhookQueue = "webhook-queue",
  EntityChangeQueue = "entity-change-queue",
  EventPropagationQueue = "event-propagation-queue",
  NotificationQueue = "notification-queue",
  DorisSplitTableProvisioningQueue = "doris-split-table-provisioning-queue",
}

export enum QueueJobs {
  TraceUpsert = "trace-upsert",
  TraceDelete = "trace-delete",
  ProjectDelete = "project-delete",
  DatasetRunItemUpsert = "dataset-run-item-upsert",
  EvaluationExecution = "evaluation-execution-job",
  LLMAsJudgeExecution = "llm-as-a-judge-execution-job",
  BatchExportJob = "batch-export-job",
  OtelIngestionJob = "otel-ingestion-job",
  IngestionJob = "ingestion-job",
  IngestionSecondaryJob = "secondary-ingestion-job",
  CloudUsageMeteringJob = "cloud-usage-metering-job",
  CloudFreeTierUsageThresholdJob = "cloud-free-tier-usage-threshold-job",
  ExperimentCreateJob = "experiment-create-job",
  PostHogIntegrationJob = "posthog-integration-job",
  PostHogIntegrationProcessingJob = "posthog-integration-processing-job",
  MixpanelIntegrationJob = "mixpanel-integration-job",
  MixpanelIntegrationProcessingJob = "mixpanel-integration-processing-job",
  BlobStorageIntegrationJob = "blobstorage-integration-job",
  BlobStorageIntegrationProcessingJob = "blobstorage-integration-processing-job",
  CoreDataS3ExportJob = "core-data-s3-export-job",
  BatchActionProcessingJob = "batch-action-processing-job",
  CreateEvalJob = "create-eval-job",
  ScoreDelete = "score-delete",
  DatasetDelete = "dataset-delete-job",
  DeadLetterRetryJob = "dead-letter-retry-job",
  WebhookJob = "webhook-job",
  EntityChangeJob = "entity-change-job",
  EventPropagationJob = "event-propagation-job",
  NotificationJob = "notification-job",
  DorisSplitTableProvisioningJob = "doris-split-table-provisioning-job",
}

export type TQueueJobTypes = {
  [QueueName.TraceUpsert]: {
    timestamp: Date;
    id: string;
    payload: TraceQueueEventType;
    name: QueueJobs.TraceUpsert;
  };
  [QueueName.TraceDelete]: {
    timestamp: Date;
    id: string;
    payload: TracesQueueEventType | TraceQueueEventType;
    name: QueueJobs.TraceDelete;
  };
  [QueueName.ScoreDelete]: {
    timestamp: Date;
    id: string;
    payload: ScoresQueueEventType;
    name: QueueJobs.ScoreDelete;
  };
  [QueueName.DatasetDelete]: {
    timestamp: Date;
    id: string;
    payload: DatasetQueueEventType;
    name: QueueJobs.DatasetDelete;
  };
  [QueueName.ProjectDelete]: {
    timestamp: Date;
    id: string;
    payload: ProjectQueueEventType;
    name: QueueJobs.ProjectDelete;
  };
  [QueueName.DatasetRunItemUpsert]: {
    timestamp: Date;
    id: string;
    payload: DatasetRunItemUpsertEventType;
    name: QueueJobs.DatasetRunItemUpsert;
    retryBaggage?: RetryBaggage;
  };
  [QueueName.EvaluationExecution]: {
    timestamp: Date;
    id: string;
    payload: EvalExecutionEventType;
    name: QueueJobs.EvaluationExecution;
    retryBaggage?: RetryBaggage;
  };
  [QueueName.EvaluationExecutionSecondaryQueue]: {
    timestamp: Date;
    id: string;
    payload: EvalExecutionEventType;
    name: QueueJobs.EvaluationExecution;
    retryBaggage?: RetryBaggage;
  };
  [QueueName.LLMAsJudgeExecution]: {
    timestamp: Date;
    id: string;
    payload: LLMAsJudgeExecutionEventType;
    name: QueueJobs.LLMAsJudgeExecution;
    retryBaggage?: RetryBaggage;
  };
  [QueueName.BatchExport]: {
    timestamp: Date;
    id: string;
    payload: BatchExportJobType;
    name: QueueJobs.BatchExportJob;
  };
  [QueueName.OtelIngestionQueue]: {
    // First-enqueue time. PRESERVED verbatim across DLQ redrives (the
    // redrive re-adds the same envelope) — the age guard reads it to refuse
    // replays older than the FE label retention window.
    timestamp: Date;
    id: string;
    // Legacy per-file shape | group shape (exactly-once pipeline). Consumers
    // route on `"shape" in payload`; producers: web adds legacy (grouping
    // off), the grouper adds group jobs.
    payload: OtelIngestionEventQueueType | OtelGroupIngestionEventType;
    name: QueueJobs.OtelIngestionJob;
    /** DLQ redrive count (absent until the first redrive). */
    redrives?: number;
  };
  [QueueName.IngestionQueue]: {
    timestamp: Date;
    id: string;
    payload: IngestionEventQueueType;
    name: QueueJobs.IngestionJob;
  };
  [QueueName.IngestionSecondaryQueue]: {
    timestamp: Date;
    id: string;
    payload: IngestionEventQueueType;
    name: QueueJobs.IngestionJob;
  };
  [QueueName.CloudUsageMeteringQueue]: {
    timestamp: Date;
    id: string;
    payload: Record<string, never>;
    name: QueueJobs.CloudUsageMeteringJob;
  };
  [QueueName.CloudFreeTierUsageThresholdQueue]: {
    timestamp: Date;
    id: string;
    payload: Record<string, never>;
    name: QueueJobs.CloudFreeTierUsageThresholdJob;
  };
  [QueueName.ExperimentCreate]: {
    timestamp: Date;
    id: string;
    payload: ExperimentCreateEventType;
    name: QueueJobs.ExperimentCreateJob;
    retryBaggage?: RetryBaggage;
  };
  [QueueName.PostHogIntegrationProcessingQueue]: {
    timestamp: Date;
    id: string;
    payload: PostHogIntegrationProcessingEventType;
    name: QueueJobs.PostHogIntegrationProcessingJob;
  };
  [QueueName.MixpanelIntegrationProcessingQueue]: {
    timestamp: Date;
    id: string;
    payload: MixpanelIntegrationProcessingEventType;
    name: QueueJobs.MixpanelIntegrationProcessingJob;
  };
  [QueueName.BatchActionQueue]: {
    timestamp: Date;
    id: string;
    payload: BatchActionProcessingEventType;
    name: QueueJobs.BatchActionProcessingJob;
  };
  [QueueName.CreateEvalQueue]: {
    timestamp: Date;
    id: string;
    payload: CreateEvalQueueEventType;
    name: QueueJobs.CreateEvalJob;
  };
  [QueueName.BlobStorageIntegrationProcessingQueue]: {
    timestamp: Date;
    id: string;
    payload: BlobStorageIntegrationProcessingEventType;
    name: QueueJobs.BlobStorageIntegrationProcessingJob;
  };
  [QueueName.DeadLetterRetryQueue]: {
    timestamp: Date;
    id: string;
    payload: DeadLetterRetryQueueEventType;
    name: QueueJobs.DeadLetterRetryJob;
  };
  [QueueName.WebhookQueue]: {
    timestamp: Date;
    id: string;
    payload: WebhookInput;
    name: QueueJobs.WebhookJob;
  };
  [QueueName.EntityChangeQueue]: {
    timestamp: Date;
    id: string;
    payload: EntityChangeEventType;
    name: QueueJobs.EntityChangeJob;
  };
  [QueueName.EventPropagationQueue]: {
    timestamp: Date;
    id: string;
    name: QueueJobs.EventPropagationJob;
  };
  [QueueName.NotificationQueue]: {
    timestamp: Date;
    id: string;
    payload: NotificationEventType;
    name: QueueJobs.NotificationJob;
  };
  [QueueName.DorisSplitTableProvisioningQueue]: {
    timestamp: Date;
    id: string;
    payload: { projectId: string };
    name: QueueJobs.DorisSplitTableProvisioningJob;
  };
};
