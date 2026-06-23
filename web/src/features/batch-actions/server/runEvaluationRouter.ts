import { auditLog } from "@/src/features/audit-logs/auditLog";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import {
  BatchActionQueue,
  logger,
  QueueJobs,
  getObservationsCountFromEventsTable,
  getTracesTableCount,
} from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";
import {
  BatchTableNames,
  BatchActionStatus,
  ActionId,
  BatchEvalSourceTable,
  getEvalTargetObjectFromSourceTable,
} from "@langfuse/shared";
import { env } from "@/src/env.mjs";
import { CreateObservationBatchEvaluationActionSchema } from "../validation";

export const runEvaluationRouter = createTRPCRouter({
  create: protectedProjectProcedure
    .input(CreateObservationBatchEvaluationActionSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        throwIfNoProjectAccess({
          session: ctx.session,
          projectId: input.projectId,
          scope: "evalJob:CUD",
        });

        const { projectId, query, evaluatorIds: rawEvaluatorIds } = input;
        const sourceTable = input.sourceTable ?? BatchEvalSourceTable.EVENTS;

        if (
          sourceTable !== BatchEvalSourceTable.TRACES &&
          env.LITEFUSE_ENABLE_EVENTS_TABLE_FLAGS !== "true"
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Events table is not enabled for this instance.",
          });
        }

        const targetObject = getEvalTargetObjectFromSourceTable(sourceTable);
        const actionId =
          sourceTable === BatchEvalSourceTable.TRACES
            ? ActionId.TraceBatchEvaluation
            : ActionId.ObservationBatchEvaluation;
        const batchTableName =
          sourceTable === BatchEvalSourceTable.TRACES
            ? BatchTableNames.Traces
            : BatchTableNames.Events;
        const scopeLabel =
          sourceTable === BatchEvalSourceTable.TRACES ? "trace" : "observation";

        const requestedEvaluatorIds = Array.from(new Set(rawEvaluatorIds));

        const evaluatorIds = (
          await ctx.prisma.jobConfiguration.findMany({
            where: {
              id: {
                in: requestedEvaluatorIds,
              },
              projectId,
              targetObject,
            },
            select: {
              id: true,
            },
          })
        ).map((e) => e.id);

        if (evaluatorIds.length !== requestedEvaluatorIds.length) {
          const foundIds = new Set(evaluatorIds);
          const missingEvaluatorIds = requestedEvaluatorIds.filter(
            (id) => !foundIds.has(id),
          );

          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              missingEvaluatorIds.length > 0
                ? `Evaluators [${missingEvaluatorIds.join(", ")}] are missing or not ${scopeLabel}-scoped.`
                : `Selected evaluators are missing or not ${scopeLabel}-scoped.`,
          });
        }

        const matchedCount =
          sourceTable === BatchEvalSourceTable.TRACES
            ? await getTracesTableCount({
                projectId,
                filter: query.filter ?? [],
                searchQuery: query.searchQuery,
                searchType: query.searchType ?? ["id"],
                orderBy: query.orderBy,
              })
            : await getObservationsCountFromEventsTable({
                projectId,
                filter: query.filter ?? [],
                searchQuery: query.searchQuery,
                searchType: query.searchType,
                selectIOAndMetadata: false,
              });

        if (matchedCount > env.LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Too many ${scopeLabel}s selected. Maximum allowed is ${env.LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT}, but ${matchedCount} ${scopeLabel}s match your filters. Please refine your filters to reduce the count.`,
          });
        }

        const userId = ctx.session.user.id;
        const batchConfig = { evaluatorIds };

        logger.info("[TRPC] Creating batched evaluation action", {
          projectId,
          sourceTable,
          targetObject,
          evaluatorCount: evaluatorIds.length,
          evaluatorIds,
        });

        const batchAction = await ctx.prisma.batchAction.create({
          data: {
            projectId,
            userId,
            actionType: actionId,
            tableName: batchTableName,
            status: BatchActionStatus.Queued,
            query,
            config: batchConfig,
          },
        });

        await auditLog({
          session: ctx.session,
          resourceType: "batchAction",
          resourceId: batchAction.id,
          projectId,
          action: actionId,
          after: batchAction,
        });

        await BatchActionQueue.getInstance()?.add(
          QueueJobs.BatchActionProcessingJob,
          {
            id: batchAction.id,
            name: QueueJobs.BatchActionProcessingJob,
            timestamp: new Date(),
            payload: {
              actionId,
              batchActionId: batchAction.id,
              projectId,
              cutoffCreatedAt: new Date(),
              query,
              evaluatorIds: batchConfig.evaluatorIds,
            },
          },
          {
            jobId: batchAction.id,
          },
        );

        return { id: batchAction.id };
      } catch (e) {
        logger.error(e);
        if (e instanceof TRPCError) {
          throw e;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Creating run-evaluation action failed.",
        });
      }
    }),
});
