import { type z } from "zod/v4";
import { z as zodSchema } from "zod/v4";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import {
  type Observation,
  type OrderByState,
  normalizeOrderByForTable,
  paginationZod,
  timeFilter,
} from "@langfuse/shared";
import { EventsTableOptions } from "./types";
import {
  getEventList,
  getEventListCursor,
  getEventCount,
  getEventFilterOptions,
  getEventBatchIO,
} from "./eventsService";
import {
  instrumentAsync,
  getScoresAndCorrectionsForTraces,
  convertDateToAnalyticsDateTime,
  getAgentGraphDataFromEventsTable,
  getObservationsForTraceFromEventsTable,
  MAX_OBSERVATIONS_PER_TRACE,
  applyCommentFilters,
  type EventBatchIOExtraFields,
} from "@langfuse/shared/src/server";

import {
  AgentGraphDataSchema,
  type AgentGraphDataResponse,
} from "@/src/features/trace-graph-view/types";
import type * as opentelemetry from "@opentelemetry/api";

const GetAllEventsInput = EventsTableOptions.extend({
  ...paginationZod,
});

/**
 * Cursor pagination reads the events table in its stable
 * (startTime, traceId, id) tuple order and cannot honour an arbitrary sort, so
 * the caller's `orderBy` is deliberately absent instead of silently ignored.
 */
const GetEventsCursorInput = EventsTableOptions.omit({ orderBy: true }).extend({
  limit: paginationZod.limit,
  cursor: zodSchema
    .object({
      lastStartTimeTo: zodSchema.date(),
      lastTraceId: zodSchema.string(),
      lastId: zodSchema.string(),
    })
    .optional(),
});

export type EventBatchIOOutput = Pick<
  Observation,
  "id" | "input" | "output" | "metadata"
> &
  // LITEFUSE ADDITION (evaluators v2): present only when the caller asked for
  // them (`includeToolCallFields` / `includeExperimentFields`), which is why they
  // are optional. The mapping preview offers them as variables.
  EventBatchIOExtraFields;

export type GetAllEventsInput = z.infer<typeof GetAllEventsInput>;

export type GetEventsCursorInput = z.infer<typeof GetEventsCursorInput>;

const GetEventFilterOptionsInput = zodSchema.object({
  projectId: zodSchema.string(),
  startTimeFilter: zodSchema.array(timeFilter).optional(),
});

export type GetEventFilterOptionsInput = z.infer<
  typeof GetEventFilterOptionsInput
>;

export const BatchIOInput = zodSchema.object({
  projectId: zodSchema.string(),
  observations: zodSchema.array(
    zodSchema.object({
      id: zodSchema.string(),
      traceId: zodSchema.string(),
    }),
  ),
  minStartTime: zodSchema.date(),
  maxStartTime: zodSchema.date(),
  truncated: zodSchema.boolean().optional(), // Defaults to true for performance
  // ── LITEFUSE ADDITIONS (evaluators v2) ────────────────────────────────────
  // Upstream's batch-IO contract. The copied evaluator testing UI sends
  // `includeToolCalls: true`; `ioCharLimit` overrides the server-side truncation
  // limit. Both optional, so the pre-existing callers are untouched.
  includeToolCalls: zodSchema.boolean().optional(),
  ioCharLimit: zodSchema.number().int().positive().max(10_000).optional(),
});

export type BatchIOInput = z.infer<typeof BatchIOInput>;

export const eventsRouter = createTRPCRouter({
  all: protectedProjectProcedure
    .input(GetAllEventsInput)
    .query(async ({ input, ctx }) => {
      const { filterState, hasNoMatches } = await applyCommentFilters({
        filterState: input.filter ?? [],
        prisma: ctx.prisma,
        projectId: ctx.session.projectId,
        objectType: "OBSERVATION",
      });

      if (hasNoMatches) {
        return { observations: [] };
      }

      return instrumentAsync(
        {
          name: "get-event-list-trpc",
        },
        async (span) => {
          const normalizedOrderBy = normalizeOrderByForTable({
            orderBy: input.orderBy,
            expectedTimeColumn: "startTime",
          });
          addAttributesToSpan({ span, input, orderBy: normalizedOrderBy });

          return getEventList({
            projectId: ctx.session.projectId,
            filter: filterState,
            searchQuery: input.searchQuery ?? undefined,
            searchType: input.searchType,
            orderBy: normalizedOrderBy,
            page: input.page,
            limit: input.limit,
          });
        },
      );
    }),
  /**
   * Cursor-paginated events list. Reads the events table in its stable
   * (startTime, traceId, id) DESC keyset order and returns `nextCursor` for the
   * next page; `hasMore` is false once the last page is reached.
   */
  listCursor: protectedProjectProcedure
    .input(GetEventsCursorInput)
    .query(async ({ input, ctx }) => {
      const { filterState, hasNoMatches } = await applyCommentFilters({
        filterState: input.filter ?? [],
        prisma: ctx.prisma,
        projectId: ctx.session.projectId,
        objectType: "OBSERVATION",
      });

      if (hasNoMatches) {
        return {
          observations: [],
          hasMore: false,
          nextCursor: undefined,
        };
      }

      return instrumentAsync(
        { name: "get-event-list-cursor-trpc" },
        async (span) => {
          addAttributesToSpan({
            span,
            input,
            orderBy: { column: "startTime", order: "DESC" },
          });

          return getEventListCursor({
            projectId: ctx.session.projectId,
            filter: filterState,
            searchQuery: input.searchQuery ?? undefined,
            searchType: input.searchType,
            limit: input.limit,
            cursor: input.cursor,
          });
        },
      );
    }),
  countAll: protectedProjectProcedure
    .input(GetAllEventsInput)
    .query(async ({ input, ctx }) => {
      const { filterState, hasNoMatches } = await applyCommentFilters({
        filterState: input.filter ?? [],
        prisma: ctx.prisma,
        projectId: ctx.session.projectId,
        objectType: "OBSERVATION",
      });

      if (hasNoMatches) {
        return { totalCount: 0 };
      }

      return instrumentAsync(
        {
          name: "get-event-count-trpc",
        },
        async (span) => {
          const normalizedOrderBy = normalizeOrderByForTable({
            orderBy: input.orderBy,
            expectedTimeColumn: "startTime",
          });
          addAttributesToSpan({ span, input, orderBy: normalizedOrderBy });
          return getEventCount({
            projectId: ctx.session.projectId,
            filter: filterState,
            searchQuery: input.searchQuery ?? undefined,
            searchType: input.searchType,
            orderBy: normalizedOrderBy,
          });
        },
      );
    }),
  filterOptions: protectedProjectProcedure
    .input(
      zodSchema.object({
        projectId: zodSchema.string(),
        startTimeFilter: zodSchema.array(timeFilter).optional(),
        hasParentObservation: zodSchema.boolean().optional(),
      }),
    )
    .query(async ({ input }) => {
      return instrumentAsync(
        {
          name: "get-event-filter-options-trpc",
        },

        async (span) => {
          addAttributesToSpan({ span, input, orderBy: undefined });
          return getEventFilterOptions({
            projectId: input.projectId,
            startTimeFilter: input.startTimeFilter,
            hasParentObservation: input.hasParentObservation,
          });
        },
      );
    }),
  batchIO: protectedProjectProcedure
    .input(BatchIOInput)
    .query(async ({ input, ctx }) => {
      return instrumentAsync(
        { name: "get-event-batch-io-trpc" },
        async (span) => {
          span.setAttribute("project_id", input.projectId);
          span.setAttribute("observation_count", input.observations.length);

          return getEventBatchIO({
            projectId: ctx.session.projectId,
            observations: input.observations,
            minStartTime: input.minStartTime,
            maxStartTime: input.maxStartTime,
            truncated: input.truncated,
            ioCharLimit: input.ioCharLimit,
            includeToolCallFields: input.includeToolCalls,
          });
        },
      );
    }),
  /**
   * LITEFUSE ADDITION (evaluators v2): upstream's `experimentBatchIO` is the
   * same query as `batchIO` plus the experiment columns. The copied evaluator
   * testing UI asks for it because a sample can be an experiment item, and the
   * mapping preview needs those fields to offer them as variables.
   */
  experimentBatchIO: protectedProjectProcedure
    .input(BatchIOInput)
    .query(async ({ input, ctx }) => {
      return instrumentAsync(
        { name: "get-experiment-batch-io-trpc" },
        async (span) => {
          span.setAttribute("project_id", input.projectId);
          span.setAttribute("observation_count", input.observations.length);

          return getEventBatchIO({
            projectId: ctx.session.projectId,
            observations: input.observations,
            minStartTime: input.minStartTime,
            maxStartTime: input.maxStartTime,
            truncated: input.truncated,
            ioCharLimit: input.ioCharLimit,
            includeExperimentFields: true,
            includeToolCallFields: input.includeToolCalls,
          });
        },
      );
    }),
  /**
   * Fetch scores and corrections for a trace.
   * Used by the v4 trace detail view where trace data comes from events table.
   */
  scoresForTrace: protectedProjectProcedure
    .input(
      zodSchema.object({
        projectId: zodSchema.string(),
        traceId: zodSchema.string(),
        timestamp: zodSchema.date().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      return instrumentAsync(
        { name: "get-events-scores-for-trace-trpc" },
        async (span) => {
          span.setAttribute("project_id", input.projectId);
          span.setAttribute("trace_id", input.traceId);

          return getScoresAndCorrectionsForTraces({
            projectId: ctx.session.projectId,
            traceIds: [input.traceId],
            timestamp: input.timestamp,
          });
        },
      );
    }),
  /**
   * Fetch all observations for a trace from the events table.
   * Returns up to MAX_OBSERVATIONS_PER_TRACE observations.
   * Sets cutoffObservationsAfterMaxCount=true if trace exceeds the cap.
   */
  byTraceId: protectedProjectProcedure
    .input(
      zodSchema.object({
        projectId: zodSchema.string(),
        traceId: zodSchema.string(),
        timestamp: zodSchema.date().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      return instrumentAsync(
        { name: "get-events-by-trace-id-trpc" },
        async (span) => {
          span.setAttribute("project_id", ctx.session.projectId);
          span.setAttribute("trace_id", input.traceId);

          const { observations, totalCount } =
            await getObservationsForTraceFromEventsTable({
              projectId: ctx.session.projectId,
              traceId: input.traceId,
              timestamp: input.timestamp,
            });

          return {
            observations,
            cutoffObservationsAfterMaxCount:
              totalCount > MAX_OBSERVATIONS_PER_TRACE,
          };
        },
      );
    }),
  /**
   * Fetch agent graph data from events table.
   * Used by v4 events-based trace detail view for graph visualization.
   * Returns same shape as traces.getAgentGraphData for frontend compatibility.
   */
  getAgentGraphData: protectedProjectProcedure
    .input(
      zodSchema.object({
        projectId: zodSchema.string(),
        traceId: zodSchema.string(),
        minStartTime: zodSchema.string(),
        maxStartTime: zodSchema.string(),
      }),
    )
    .query(
      async ({ input, ctx }): Promise<Required<AgentGraphDataResponse>[]> => {
        return instrumentAsync(
          { name: "get-events-agent-graph-data-trpc" },
          async (span) => {
            span.setAttribute("project_id", input.projectId);
            span.setAttribute("trace_id", input.traceId);

            const { traceId, minStartTime, maxStartTime } = input;

            const chMinStartTime = convertDateToAnalyticsDateTime(
              new Date(minStartTime),
            );
            const chMaxStartTime = convertDateToAnalyticsDateTime(
              new Date(maxStartTime),
            );

            const records = await getAgentGraphDataFromEventsTable({
              projectId: ctx.session.projectId,
              traceId,
              chMinStartTime,
              chMaxStartTime,
            });

            // Transform to AgentGraphDataResponse format
            // TODO: Extract this transformation logic into a shared utility
            // (duplicated from traces.getAgentGraphData in traces.ts)
            const result = records
              .map((r) => {
                const parsed = AgentGraphDataSchema.safeParse(r);
                if (!parsed.success) {
                  return null;
                }

                const data = parsed.data;
                const hasLangGraphData = data.step != null && data.node != null;
                const hasAgentData = data.type !== "EVENT";

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
              .filter((r): r is Required<AgentGraphDataResponse> => Boolean(r));

            return result;
          },
        );
      },
    ),
});

export const addAttributesToSpan = ({
  span,
  input,
  orderBy,
}: {
  span: opentelemetry.Span;
  input: GetAllEventsInput | GetEventFilterOptionsInput | GetEventsCursorInput;
  orderBy?: OrderByState;
}) => {
  span.setAttribute("project_id", input.projectId);

  // Only process filter if it exists (not present in GetEventFilterOptionsInput)
  if ("filter" in input && input.filter) {
    const startTimeFilter = input.filter.find(
      (f) => f.column === "startTime" && f.type === "datetime",
    );
    const endTimeFilter = input.filter.find(
      (f) => f.column === "endTime" && f.type === "datetime",
    );

    if (startTimeFilter?.value && endTimeFilter?.value) {
      const durationMs = dateDiff(
        startTimeFilter.value as Date,
        endTimeFilter.value as Date,
      );
      // Convert milliseconds to minutes
      span.setAttribute("duration_minutes", durationMs / 60000);
    }

    input.filter.forEach((f) => {
      if (f.value !== undefined) {
        span.setAttribute(f.column, String(f.value));
      }
    });
  }

  if (orderBy) {
    span.setAttribute("order_by_column", orderBy.column);
    span.setAttribute("order_by_order", orderBy.order ?? "DESC");
  }
};

export const dateDiff = (date1: Date, date2: Date) => {
  return Math.abs(date2.getTime() - date1.getTime());
};
