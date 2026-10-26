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
} from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";
import {
  BatchTableNames,
  BatchActionStatus,
  ActionId,
  EvalTargetObject,
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
        const { evaluatorMappings, sampling, rowLimit } = input;

        // LITEFUSE: upstream gated this endpoint on
        // `LITEFUSE_ENABLE_EVENTS_TABLE_FLAGS` because both the count below and
        // the worker's historic read stream targeted a physical `events` table.
        // That table does not exist here — telemetry is split per project — and
        // the read path was adapted instead of the storage
        // (worker/src/features/database-read-stream/event-stream.ts reads
        // `spans_<projectId>`, and `getObservationsCountFromEventsTable` already
        // resolves the split `spans` table), so nothing on this path depends on
        // that flag any more. Rejecting the request would only have kept a
        // working feature unreachable while the flag defaults to "false".

        const requestedEvaluatorIds = Array.from(new Set(rawEvaluatorIds));

        // ── LITEFUSE ADDITION (evaluators v2) ───────────────────────────────
        // A batch run may address either id space:
        //   * v2 `evaluators` rows (what the migrated UI selects), or
        //   * legacy `job_configurations` rows (still reachable in the old UI).
        // The flag travels with the queue payload so the worker resolves the same
        // space instead of guessing.
        const stableEvaluatorIds = (
          await ctx.prisma.evaluator.findMany({
            where: { id: { in: requestedEvaluatorIds }, projectId },
            select: { id: true },
          })
        ).map((e) => e.id);

        const legacyEvaluatorIds = (
          await ctx.prisma.jobConfiguration.findMany({
            where: {
              id: {
                in: requestedEvaluatorIds,
              },
              projectId,
              targetObject: EvalTargetObject.EVENT,
            },
            select: {
              id: true,
            },
          })
        ).map((e) => e.id);

        const resolutionByEvaluatorId = new Map<string, "v2" | "legacy">([
          ...stableEvaluatorIds.map((id) => [id, "v2"] as const),
          ...legacyEvaluatorIds.map((id) => [id, "legacy"] as const),
        ]);

        if (resolutionByEvaluatorId.size !== requestedEvaluatorIds.length) {
          const missingEvaluatorIds = requestedEvaluatorIds.filter(
            (id) => !resolutionByEvaluatorId.has(id),
          );

          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              missingEvaluatorIds.length > 0
                ? `Evaluators [${missingEvaluatorIds.join(", ")}] are missing or not observation-scoped.`
                : "Selected evaluators are missing or not observation-scoped.",
          });
        }

        // Mixed selections would need two different worker resolutions; the UIs
        // never produce one, so reject it instead of guessing.
        const resolvedVersions = new Set(resolutionByEvaluatorId.values());
        if (resolvedVersions.size > 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Select evaluators from one generation at a time (evaluators v2 or legacy configurations).",
          });
        }

        const evalVersion = resolvedVersions.has("v2") ? "v2" : undefined;
        const evaluatorIds = requestedEvaluatorIds;

        const countQueryOpts = {
          projectId,
          filter: query.filter ?? [],
          searchQuery: query.searchQuery,
          searchType: query.searchType,
          selectIOAndMetadata: false,
        };

        const observationCount =
          await getObservationsCountFromEventsTable(countQueryOpts);

        if (observationCount > env.LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Too many observations selected. Maximum allowed is ${env.LITEFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT}, but ${observationCount} observations match your filters. Please refine your filters to reduce the count.`,
          });
        }

        const userId = ctx.session.user.id;
        // ── LITEFUSE ADDITION (evaluators v2) ───────────────────────────────
        // The v2 backfill dialog sends the sampling fraction, its own row cap and
        // per-evaluator mappings. They are persisted on the batch action (so a
        // retry reproduces the run) and forwarded in the queue payload; the worker
        // applies sampling per observation and caps the read stream.
        const batchConfig = {
          evaluatorIds,
          // LITEFUSE ADDITION: remember which id space this run addressed, so a
          // retried batch action (and the worker) resolve the same rows.
          ...(evalVersion ? { evalVersion } : {}),
          ...(evaluatorMappings ? { evaluatorMappings } : {}),
          ...(sampling !== undefined ? { sampling } : {}),
          ...(rowLimit !== undefined ? { rowLimit } : {}),
        };

        logger.info(
          "[TRPC] Creating observation-run-batched-evaluation action",
          {
            projectId,
            evaluatorCount: evaluatorIds.length,
            evaluatorIds,
            evalVersion: evalVersion ?? "legacy",
            sampling: sampling ?? 1,
            rowLimit: rowLimit ?? null,
          },
        );

        const batchAction = await ctx.prisma.batchAction.create({
          data: {
            projectId,
            userId,
            actionType: ActionId.ObservationBatchEvaluation,
            tableName: BatchTableNames.Events,
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
          action: ActionId.ObservationBatchEvaluation,
          after: batchAction,
        });

        await BatchActionQueue.getInstance()?.add(
          QueueJobs.BatchActionProcessingJob,
          {
            id: batchAction.id,
            name: QueueJobs.BatchActionProcessingJob,
            timestamp: new Date(),
            payload: {
              actionId: ActionId.ObservationBatchEvaluation,
              batchActionId: batchAction.id,
              projectId,
              cutoffCreatedAt: new Date(),
              query,
              evaluatorIds: batchConfig.evaluatorIds,
              ...(evalVersion ? { evalVersion } : {}),
              ...(evaluatorMappings ? { evaluatorMappings } : {}),
              ...(sampling !== undefined ? { sampling } : {}),
              ...(rowLimit !== undefined ? { rowLimit } : {}),
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
