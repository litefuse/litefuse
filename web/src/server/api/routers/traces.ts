import { z } from "zod/v4";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { aggregateScores } from "@/src/features/scores/lib/aggregateScores";
import {
  applyCommentFilters,
  applyScoreFilters,
  isScoreFilterColumn,
} from "@langfuse/shared/src/server";
import {
  createTRPCRouter,
  protectedGetTraceProcedure,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import {
  BatchActionQuerySchema,
  BatchExportTableName,
  BatchActionType,
  ActionId,
  filterAndValidateDbScoreList,
  normalizeOrderByForTable,
  orderBy,
  paginationZod,
  singleFilter,
  timeFilter,
  type Observation,
  TracingSearchType,
  type ScoreDomain,
  AGGREGATABLE_SCORE_TYPES,
  ScoreDataTypeEnum,
} from "@langfuse/shared";
import {
  traceException,
  getTracesTable,
  getTracesTableCount,
  getScoresForTraces,
  getNumericScoresGroupedByName,
  getTracesGroupedByName,
  getTracesGroupedByTags,
  getObservationsForTrace,
  getTraceById,
  logger,
  hasAnyTrace,
  traceDeletionProcessor,
  getTracesTableMetrics,
  getCategoricalScoresGroupedByName,
  convertDateToAnalyticsDateTime,
  getAgentGraphData,
  getTraceUsageBreakdown,
  tracesTableUiColumnDefinitionsForDoris,
  getTracesGroupedByUsers,
  getTracesGroupedBySessionId,
  getScoresAndCorrectionsForTraces,
  partialUpdateDoris,
} from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";
import { createBatchActionJob } from "@/src/features/table/server/createBatchActionJob";
import { throwIfNoEntitlement } from "@/src/features/entitlements/server/hasEntitlement";
import {
  type AgentGraphDataResponse,
  AgentGraphDataSchema,
} from "@/src/features/trace-graph-view/types";
import {
  toDomainWithStringifiedMetadata,
  toDomainArrayWithStringifiedMetadata,
} from "@/src/utils/clientSideDomainTypes";
import partition from "lodash/partition";
import { getTracePreviews } from "@/src/features/traces/server/tracePreviewService";

const TraceFilterOptions = z.object({
  projectId: z.string(), // Required for protectedProjectProcedure
  searchQuery: z.string().nullable(),
  searchType: z.array(TracingSearchType),
  filter: z.array(singleFilter).nullable(),
  orderBy: orderBy,
  ...paginationZod,
});
type TraceFilterOptions = z.infer<typeof TraceFilterOptions>;

export type ObservationReturnTypeWithMetadata = Omit<
  Observation,
  "input" | "output" | "metadata"
> & {
  traceId: string;
  metadata: string | null;
  // optional, because in v4 an observation can have those properties
  userId?: string | null;
  sessionId?: string | null;
};

export type ObservationReturnType = Omit<
  ObservationReturnTypeWithMetadata,
  "metadata"
>;

export const traceRouter = createTRPCRouter({
  batchPreviews: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        traces: z
          .array(z.object({ id: z.string().min(1), timestamp: z.date() }))
          .max(1000),
        includeMetadata: z.boolean().default(false),
      }),
    )
    .query(({ input, ctx }) =>
      getTracePreviews({
        projectId: ctx.session.projectId,
        traces: input.traces,
        includeMetadata: input.includeMetadata,
      }),
    ),
  hasTracingConfigured: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Check if there are any traces in the database
      const hasTraces = await hasAnyTrace(input.projectId);

      if (hasTraces) {
        return true;
      }

      // If no traces, check if data retention is configured
      // This indicates the user has configured tracing even if data retention cleaned all traces
      const project = await ctx.prisma.project.findUnique({
        where: {
          id: input.projectId,
        },
        select: {
          retentionDays: true,
        },
      });

      return !!(project?.retentionDays && project.retentionDays > 0);
    }),
  all: protectedProjectProcedure
    .input(TraceFilterOptions)
    .query(async ({ input, ctx }) => {
      const { filterState, hasNoMatches } = await applyCommentFilters({
        filterState: input.filter ?? [],
        prisma: ctx.prisma,
        projectId: ctx.session.projectId,
        objectType: "TRACE",
      });

      if (hasNoMatches) {
        return { traces: [] };
      }

      // Pre-resolve score filters into a trace_id list so the list query stays on
      // the traces_mv fast path (scores live in their own table — a JOIN would
      // pull it off the MV). See applyScoreFilters.
      const { filterState: scoredFilterState, hasNoMatches: noScoreMatches } =
        await applyScoreFilters({
          filterState,
          projectId: ctx.session.projectId,
        });

      if (noScoreMatches) {
        return { traces: [] };
      }

      const traces = await getTracesTable({
        projectId: ctx.session.projectId,
        filter: scoredFilterState,
        searchQuery: input.searchQuery ?? undefined,
        searchType: input.searchType ?? ["id"],
        orderBy: normalizeOrderByForTable({
          orderBy: input.orderBy,
          expectedTimeColumn: "timestamp",
        }),
        limit: input.limit,
        page: input.page,
      });
      return { traces };
    }),
  countAll: protectedProjectProcedure
    .input(TraceFilterOptions)
    .query(async ({ input, ctx }) => {
      const { filterState, hasNoMatches } = await applyCommentFilters({
        filterState: input.filter ?? [],
        prisma: ctx.prisma,
        projectId: ctx.session.projectId,
        objectType: "TRACE",
      });

      if (hasNoMatches) {
        return { totalCount: 0 };
      }

      const { filterState: scoredFilterState, hasNoMatches: noScoreMatches } =
        await applyScoreFilters({
          filterState,
          projectId: ctx.session.projectId,
        });

      if (noScoreMatches) {
        return { totalCount: 0 };
      }

      const count = await getTracesTableCount({
        projectId: ctx.session.projectId,
        filter: scoredFilterState,
        searchType: input.searchType,
        searchQuery: input.searchQuery ?? undefined,
        limit: 1,
        page: 0,
      });

      return {
        totalCount: count,
      };
    }),
  metrics: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        traceIds: z.array(z.string()),
        filter: z.array(singleFilter).nullable(),
      }),
    )
    .query(async ({ input, ctx }) => {
      if (input.traceIds.length === 0) return [];

      const { filterState, hasNoMatches, matchingIds } =
        await applyCommentFilters({
          filterState: input.filter ?? [],
          prisma: ctx.prisma,
          projectId: ctx.session.projectId,
          objectType: "TRACE",
        });

      if (hasNoMatches) {
        return [];
      }

      // If comment filters returned matching IDs, intersect with input.traceIds
      let filteredTraceIds = input.traceIds;
      if (matchingIds !== null) {
        filteredTraceIds = input.traceIds.filter((id) =>
          matchingIds.includes(id),
        );

        if (filteredTraceIds.length === 0) {
          return [];
        }
      }

      // Remove the comment filter's ID injection and use filteredTraceIds instead.
      // Also drop score filters: the page's traceIds were already score-filtered in
      // traces.all, so re-applying them here would only add a redundant scores JOIN
      // (pulling metrics off the traces_mv fast path).
      const filterWithoutCommentIds = filterState.filter(
        (f) =>
          !(
            f.type === "stringOptions" &&
            f.column === "id" &&
            f.operator === "any of"
          ) && !isScoreFilterColumn(f.column),
      );

      const res = await getTracesTableMetrics({
        projectId: ctx.session.projectId,
        filter: [
          ...filterWithoutCommentIds,
          {
            type: "stringOptions",
            operator: "any of",
            column: "ID",
            value: filteredTraceIds,
          },
        ],
        orderBy: { column: "timestamp", order: "DESC" },
      });

      const traceScores = await getScoresForTraces({
        projectId: ctx.session.projectId,
        traceIds: res.map((r) => r.id),
        limit: 1000,
        offset: 0,
        excludeMetadata: true,
        includeHasMetadata: true,
      });

      const validatedScores = filterAndValidateDbScoreList({
        scores: traceScores,
        dataTypes: AGGREGATABLE_SCORE_TYPES,
        includeHasMetadata: true,
        onParseError: traceException,
      });

      return res.map((row) => ({
        ...row,
        scores: aggregateScores(
          validatedScores.filter((s) => s.traceId === row.id),
        ),
      }));
    }),
  filterOptions: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        timestampFilter: z.array(timeFilter).optional(),
      }),
    )
    .query(async ({ input }) => {
      const { timestampFilter } = input;

      const [
        numericScoreNames,
        categoricalScoreNames,
        traceNames,
        tags,
        userIds,
        sessionIds,
      ] = await Promise.all([
        getNumericScoresGroupedByName(input.projectId, timestampFilter ?? []),
        getCategoricalScoresGroupedByName(
          input.projectId,
          timestampFilter ?? [],
        ),
        getTracesGroupedByName(
          input.projectId,
          tracesTableUiColumnDefinitionsForDoris,
          timestampFilter ?? [],
        ),
        getTracesGroupedByTags({
          projectId: input.projectId,
          filter: timestampFilter ?? [],
        }),
        getTracesGroupedByUsers(
          input.projectId,
          timestampFilter ?? [],
          undefined,
          100,
          0,
        ),
        getTracesGroupedBySessionId(
          input.projectId,
          timestampFilter ?? [],
          undefined,
          100,
          0,
        ),
      ]);

      return {
        name: traceNames.map((n) => ({ value: n.name, count: n.count })),
        scores_avg: numericScoreNames.map((s) => s.name),
        score_categories: categoricalScoreNames,
        tags: tags,
        users: userIds.map((u) => ({
          value: u.user,
          count: u.count,
        })),
        sessions: sessionIds.map((s) => ({
          value: s.session_id,
          count: s.count,
        })),
      };
    }),
  byId: protectedGetTraceProcedure
    .input(
      z.object({
        traceId: z.string(), // used for security check
        projectId: z.string(), // used for security check
        timestamp: z.date().nullish(), // timestamp of the trace. Used to query CH more efficiently
        fromTimestamp: z.date().nullish(), // min timestamp of the trace. Used to query CH more efficiently
        verbosity: z.enum(["compact", "truncated", "full"]).default("full"),
      }),
    )
    .query(async ({ ctx }) => {
      return {
        ...ctx.trace,
        input: ctx.trace.input as string,
        output: ctx.trace.output as string,
        metadata: ctx.trace.metadata
          ? JSON.stringify(ctx.trace.metadata)
          : undefined,
      };
    }),
  // Per-trace usage/cost breakdown for the traces-list hover tooltip. The list
  // metrics query returns only scalar totals; the per-key breakdown is fetched
  // lazily here when the user hovers a row (scoped to one trace → one bucket).
  usageBreakdownById: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        traceId: z.string(),
        timestamp: z.date().nullish(),
      }),
    )
    .query(async ({ input }) => {
      return getTraceUsageBreakdown({
        projectId: input.projectId,
        traceId: input.traceId,
        timestamp: input.timestamp ?? undefined,
      });
    }),
  byIdWithObservationsAndScores: protectedGetTraceProcedure
    .input(
      z.object({
        traceId: z.string(), // used for security check
        timestamp: z.date().nullish(), // timestamp of the trace. Used to query CH more efficiently
        fromTimestamp: z.date().nullish(), // min timestamp of the trace. Used to query CH more efficiently
        projectId: z.string(), // used for security check
      }),
    )
    .query(async ({ input, ctx }) => {
      if (!ctx.trace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Trace not found",
        });
      }

      const [observations, traceScores] = await Promise.all([
        getObservationsForTrace({
          traceId: input.traceId,
          projectId: input.projectId,
          timestamp: input.timestamp ?? input.fromTimestamp ?? undefined,
          includeIO: false,
        }),
        getScoresAndCorrectionsForTraces({
          projectId: input.projectId,
          traceIds: [input.traceId],
          timestamp: input.timestamp ?? input.fromTimestamp ?? undefined,
        }),
      ]);

      const validatedScores = filterAndValidateDbScoreList({
        scores: traceScores,
        dataTypes: [...AGGREGATABLE_SCORE_TYPES, ScoreDataTypeEnum.CORRECTION],
        onParseError: traceException,
      });

      const [corrections, scores] = partition(
        validatedScores,
        (s) => s.dataType === ScoreDataTypeEnum.CORRECTION,
      );

      const obsStartTimes = observations
        .map((o) => o.startTime)
        .sort((a, b) => a.getTime() - b.getTime());
      const obsEndTimes = observations
        .map((o) => o.endTime)
        .filter((t) => t)
        .sort((a, b) => (a as Date).getTime() - (b as Date).getTime());
      const latencyMs =
        obsStartTimes.length > 0
          ? obsEndTimes.length > 0
            ? (obsEndTimes[obsEndTimes.length - 1] as Date).getTime() -
              obsStartTimes[0]!.getTime()
            : obsStartTimes.length > 1
              ? obsStartTimes[obsStartTimes.length - 1]!.getTime() -
                obsStartTimes[0]!.getTime()
              : undefined
          : undefined;

      const scoresDomain =
        toDomainArrayWithStringifiedMetadata<ScoreDomain>(scores);

      return {
        ...toDomainWithStringifiedMetadata(ctx.trace),
        input: ctx.trace.input ? JSON.stringify(ctx.trace.input) : null,
        output: ctx.trace.output ? JSON.stringify(ctx.trace.output) : null,
        scores: scoresDomain,
        corrections,
        latency: latencyMs !== undefined ? latencyMs / 1000 : undefined,
        observations: observations.map((o) => ({
          ...toDomainWithStringifiedMetadata(o),
          output: undefined,
          input: undefined, // this is not queried above.
        })) as ObservationReturnTypeWithMetadata[],
      };
    }),
  deleteMany: protectedProjectProcedure
    .input(
      z.object({
        traceIds: z.array(z.string()).min(1, "Minimum 1 traceId is required."),
        projectId: z.string(),
        query: BatchActionQuerySchema.optional(),
        isBatchAction: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "traces:delete",
      });

      throwIfNoEntitlement({
        entitlement: "trace-deletion",
        projectId: input.projectId,
        sessionUser: ctx.session.user,
      });

      if (input.isBatchAction && input.query) {
        await createBatchActionJob({
          projectId: input.projectId,
          actionId: ActionId.TraceDelete,
          actionType: BatchActionType.Delete,
          tableName: BatchExportTableName.Traces,
          session: ctx.session,
          query: input.query,
        });
      } else {
        await Promise.all(
          input.traceIds.map((traceId) =>
            auditLog({
              resourceType: "trace",
              resourceId: traceId,
              action: "delete",
              session: ctx.session,
            }),
          ),
        );

        await traceDeletionProcessor(input.projectId, input.traceIds);
      }
    }),
  bookmark: protectedProjectProcedure
    .input(
      z.object({
        traceId: z.string(),
        projectId: z.string(),
        bookmarked: z.boolean(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "objects:bookmark",
      });
      try {
        await auditLog({
          session: ctx.session,
          resourceType: "trace",
          resourceId: input.traceId,
          action: "bookmark",
          after: input.bookmarked,
        });

        let trace;

        const traceById = await getTraceById({
          traceId: input.traceId,
          projectId: input.projectId,
        });
        if (traceById) {
          trace = traceById;
          traceById.bookmarked = input.bookmarked;
          // spans is a DUPLICATE-model table (migration 0037): UPDATE
          // is unsupported, so the spans root row is NOT rewritten.
          // traces_scalar (UNIQUE/MoW) is the authoritative store for
          // trace-level mutable flags; full-verbosity byId reads that still
          // pick bookmarked from spans will surface the stale value.
          // traces_scalar serves the trace LIST (and compact byId); without
          // this mirror the toggled bookmark reverts on the next list load.
          // (The legacy `traces` table no longer exists — an UPDATE against
          // it fails the whole mutation — so it is not written.)
          await partialUpdateDoris({
            table: "traces_scalar",
            where: { project_id: input.projectId, id: input.traceId },
            set: { bookmarked: input.bookmarked },
          });
        } else {
          logger.error(
            `Trace not found in Doris: ${input.traceId}. Skipping bookmark.`,
          );
        }

        return trace;
      } catch (error) {
        logger.error("Failed to call traces.bookmark", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
        });
      }
    }),
  publish: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        traceId: z.string(),
        public: z.boolean(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "objects:publish",
      });
      try {
        await auditLog({
          session: ctx.session,
          resourceType: "trace",
          resourceId: input.traceId,
          action: "publish",
          after: input.public,
        });

        const traceById = await getTraceById({
          traceId: input.traceId,
          projectId: input.projectId,
        });
        if (!traceById) {
          logger.error(
            `Trace not found in Doris: ${input.traceId}. Skipping publishing.`,
          );
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Trace not found",
          });
        }
        traceById.public = input.public;
        // spans is DUPLICATE-model (migration 0037): UPDATE is
        // unsupported, so the per-span public flag is NOT rewritten there.
        // traces_scalar mirror — the list/compact-byId read target. (The
        // legacy `traces` table no longer exists, so it is not written.)
        await partialUpdateDoris({
          table: "traces_scalar",
          where: { project_id: input.projectId, id: input.traceId },
          set: { public: input.public },
        });
        return traceById;
      } catch (error) {
        logger.error("Failed to call traces.publish", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
        });
      }
    }),
  updateTags: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        traceId: z.string(),
        tags: z.array(z.string()),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "objects:tag",
      });
      try {
        await auditLog({
          session: ctx.session,
          resourceType: "trace",
          resourceId: input.traceId,
          action: "updateTags",
          after: input.tags,
        });

        const traceById = await getTraceById({
          traceId: input.traceId,
          projectId: input.projectId,
        });
        if (!traceById) {
          logger.error(
            `Trace not found in Doris: ${input.traceId}. Skipping tag update.`,
          );
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Trace not found",
          });
        }
        traceById.tags = input.tags;
        // spans is DUPLICATE-model (migration 0037): UPDATE is
        // unsupported, so the root-span tags are NOT rewritten there.
        // traces_scalar mirror — the list/compact-byId read target (tags
        // filters run on its inverted index). (The legacy `traces` table no
        // longer exists, so it is not written.)
        await partialUpdateDoris({
          table: "traces_scalar",
          where: { project_id: input.projectId, id: input.traceId },
          set: { tags: input.tags },
        });
      } catch (error) {
        logger.error("Failed to call traces.updateTags", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
        });
      }
    }),

  getAgentGraphData: protectedGetTraceProcedure
    .input(
      z.object({
        projectId: z.string(),
        traceId: z.string(),
        minStartTime: z.string(),
        maxStartTime: z.string(),
        // Optional fields for enforceTraceAccess middleware (supports public traces)
        timestamp: z.date().nullish(),
        fromTimestamp: z.date().nullish(),
      }),
    )
    .query(async ({ input }): Promise<Required<AgentGraphDataResponse>[]> => {
      const { traceId, projectId, minStartTime, maxStartTime } = input;

      const chMinStartTime = convertDateToAnalyticsDateTime(
        new Date(minStartTime),
      );
      const chMaxStartTime = convertDateToAnalyticsDateTime(
        new Date(maxStartTime),
      );

      const records = await getAgentGraphData({
        projectId,
        traceId,
        chMinStartTime,
        chMaxStartTime,
      });

      const result = records
        .map((r) => {
          const parsed = AgentGraphDataSchema.safeParse(r);
          if (!parsed.success) {
            return null;
          }

          const data = parsed.data;
          const hasLangGraphData = data.step != null && data.node != null;
          const hasAgentData = data.type !== "EVENT"; // Include all types except EVENT

          if (hasLangGraphData) {
            return {
              id: data.id,
              node: data.node,
              step: data.step,
              parentObservationId: data.parent_observation_id || null,
              name: data.name,
              startTime: data.start_time,
              endTime: data.end_time || undefined,
              observationType: data.type,
            };
          } else if (hasAgentData) {
            return {
              id: data.id,
              node: data.name,
              step: 0,
              parentObservationId: data.parent_observation_id || null,
              name: data.name,
              startTime: data.start_time,
              endTime: data.end_time || undefined,
              observationType: data.type,
            };
          }

          return null;
        })
        .filter((r) => Boolean(r)) as Required<AgentGraphDataResponse>[];

      return result;
    }),
});
