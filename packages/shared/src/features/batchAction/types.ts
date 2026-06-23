import z from "zod/v4";
import { singleFilter } from "../../interfaces/filters";
import { orderBy } from "../../interfaces/orderBy";
import { BatchTableNames } from "../../interfaces/tableNames";
import { TracingSearchType } from "../../interfaces/search";
import { EvalTargetObject } from "../evals/types";

export enum BatchActionType {
  Create = "create",
  Delete = "delete",
}

export enum BatchActionStatus {
  Queued = "QUEUED",
  Processing = "PROCESSING",
  Completed = "COMPLETED",
  Failed = "FAILED",
  Partial = "PARTIAL",
}

export enum ActionId {
  ScoreDelete = "score-delete",
  TraceDelete = "trace-delete",
  TraceAddToAnnotationQueue = "trace-add-to-annotation-queue",
  SessionAddToAnnotationQueue = "session-add-to-annotation-queue",
  ObservationAddToAnnotationQueue = "observation-add-to-annotation-queue",
  ObservationAddToDataset = "observation-add-to-dataset",
  ObservationBatchEvaluation = "observation-run-batched-evaluation",
  TraceBatchEvaluation = "trace-run-batched-evaluation",
}

const ActionIdSchema = z.nativeEnum(ActionId);

export const BatchEvalSourceTable = {
  EVENTS: "events",
  TRACES: "traces",
} as const;

export type BatchEvalSourceTable =
  (typeof BatchEvalSourceTable)[keyof typeof BatchEvalSourceTable];

export const BatchEvalSourceTableSchema = z.enum(
  Object.values(BatchEvalSourceTable),
);

export const getEvalTargetObjectFromSourceTable = (
  sourceTable: BatchEvalSourceTable,
) =>
  sourceTable === BatchEvalSourceTable.TRACES
    ? EvalTargetObject.TRACE
    : EvalTargetObject.EVENT;

export const BatchActionQuerySchema = z.object({
  filter: z.array(singleFilter).nullable(),
  orderBy,
  searchQuery: z.string().optional(),
  searchType: z.array(TracingSearchType).optional(),
});

export type BatchActionQuery = z.infer<typeof BatchActionQuerySchema>;

export const CreateBatchActionSchema = z.object({
  projectId: z.string(),
  actionId: ActionIdSchema,
  targetId: z.string().optional(),
  query: BatchActionQuerySchema,
  tableName: z.enum(BatchTableNames),
});

export const GetIsBatchActionInProgressSchema = z.object({
  projectId: z.string(),
  actionId: ActionIdSchema,
  tableName: z.enum(BatchTableNames),
});
