import z from "zod/v4";
import {
  AddToDatasetMappingSchema,
  ObservationAddToDatasetConfigSchema,
  BatchActionQuerySchema,
  BatchEvalEvaluatorMappingSchema,
  BatchEvalSourceTableSchema,
} from "@langfuse/shared";

export const CreateObservationAddToDatasetActionSchema = z.object({
  projectId: z.string(),
  query: BatchActionQuerySchema,
  config: ObservationAddToDatasetConfigSchema,
});

export const CreateObservationBatchEvaluationActionSchema = z.object({
  projectId: z.string(),
  query: BatchActionQuerySchema,
  evaluatorIds: z.array(z.string()).min(1),
  // ── LITEFUSE ADDITIONS (upstream-compatible, all optional) ────────────────
  // Upstream's run-evaluation call shape. Declared so the evaluators-v2 caller
  // (`useEvaluatorSavedBackfill`) type-checks against the same contract. Every
  // field is optional, so pre-existing producers keep sending exactly the
  // payload they sent before — this only stops the endpoint from *rejecting*
  // the declaration.
  //
  // NOTE: `runEvaluationRouter.create` does not consume these yet: it derives
  // the evaluator id space (v2 vs legacy) server-side from the selected ids and
  // routes by the batch action's own table/source. Accepting them here therefore
  // does not change any existing request's behaviour, but the sampled/limited
  // values an upstream caller sends are currently ignored at runtime — wiring
  // them through the router and the queue payload is a separate (server-side)
  // change.
  sourceTable: BatchEvalSourceTableSchema.optional(),
  evalVersion: z.literal("v2").optional(),
  evaluatorMappings: z.array(BatchEvalEvaluatorMappingSchema).optional(),
  sampling: z.number().min(0).max(1).optional(),
  rowLimit: z.number().int().positive().optional(),
});

export const ValidateBatchAddToDatasetMappingSchema = z.object({
  projectId: z.string(),
  observationId: z.string(),
  traceId: z.string(),
  datasetId: z.string(),
  mapping: AddToDatasetMappingSchema,
});

export const GetBatchActionByIdSchema = z.object({
  projectId: z.string(),
  batchActionId: z.string(),
});

export const ListBatchActionsSchema = z.object({
  projectId: z.string(),
  page: z.number(),
  limit: z.number(),
});
