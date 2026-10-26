import z from "zod/v4";
import { singleFilter } from "../../interfaces/filters";
import { orderBy } from "../../interfaces/orderBy";
import { BatchTableNames } from "../../interfaces/tableNames";
import { TracingSearchType } from "../../interfaces/search";

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
}

const ActionIdSchema = z.nativeEnum(ActionId);

export const BatchActionQuerySchema = z.object({
  filter: z.array(singleFilter).nullable(),
  orderBy,
  searchQuery: z.string().optional(),
  searchType: z.array(TracingSearchType).optional(),
  // Upstream-compatible opt-in for reading the job from the events table
  // instead of the legacy tables. Optional and additive: producers that do not
  // set it keep their exact previous payload, and this fork's worker routes by
  // the batch action's own table/source fields rather than by this flag, so
  // accepting (and carrying) the declaration changes no routing today.
  useEventsTable: z.boolean().optional(),
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
