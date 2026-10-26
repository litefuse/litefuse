import { api } from "@/src/utils/api";
import { useMemo } from "react";
import { type FilterState, type TimeFilter } from "@langfuse/shared";

type UseEventsFilterOptionsParams = {
  projectId: string;
  /**
   * Legacy call shape: the whole filter state, from which the start-time
   * conditions are extracted. Still supported unchanged; new callers pass
   * `startTimeFilter` (upstream's shape) instead.
   */
  oldFilterState?: FilterState;
  /**
   * Upstream-compatible explicit time scope for the options query. Merged with
   * any start-time conditions found in `refiningFilter`/`oldFilterState`.
   */
  startTimeFilter?: TimeFilter[];
  /**
   * Upstream-compatible refined filter. Accepted for call-shape compatibility;
   * this fork's `events.filterOptions` endpoint takes no refined filter, so it
   * is only used as a fallback source of start-time conditions (and replaces
   * `oldFilterState` when both are absent).
   */
  refiningFilter?: FilterState;
  /**
   * Upstream-compatible flag for the approximate matched-observation count.
   * Accepted for call-shape compatibility only: this fork's
   * `events.filterOptions` endpoint does not compute a count, so
   * `approxTotalCount` is always `null` (see the return value).
   */
  includeApproxCount?: boolean;
  /**
   * Upstream-compatible column subset. Accepted for call-shape compatibility
   * only: this fork's endpoint has no `columns` input and always returns every
   * column it can enumerate, which is a superset of any requested subset. The
   * declared element type stays `string` (rather than the endpoint enum)
   * because the subset is never forwarded.
   */
  columns?: readonly string[];
  /**
   * Upstream-compatible lazy mode. Accepted for call-shape compatibility only:
   * this fork loads all filter options in a single query, so lazy mode degrades
   * to the eager behaviour and `requestColumns` is a no-op.
   */
  lazy?: boolean;
  hasParentObservation?: boolean;
};

const EMPTY_FILTER_STATE: FilterState = [];
const EMPTY_COLUMN_SET: ReadonlySet<string> = new Set<string>();

// This fork's `events.filterOptions` query is not per-column: opening a facet
// cannot request additional columns, and there is nothing to request. Stable
// identity so consumers may depend on it (upstream's SearchComposer does).
const noopRequestColumns = (_columns: readonly string[]): void => {};

const extractStartTimeFilters = (filterState: FilterState): TimeFilter[] =>
  filterState.filter(
    (f) =>
      (f.column === "Start Time" || f.column === "startTime") &&
      f.type === "datetime",
  ) as TimeFilter[];

export function useEventsFilterOptions({
  projectId,
  oldFilterState,
  startTimeFilter: explicitStartTimeFilter,
  refiningFilter,
  includeApproxCount: _includeApproxCount,
  columns: _columns,
  lazy: _lazy,
  hasParentObservation,
}: UseEventsFilterOptionsParams) {
  // Extract start time filters for filter options query
  const startTimeFilters = useMemo(() => {
    const filterState = refiningFilter ?? oldFilterState ?? EMPTY_FILTER_STATE;
    return [
      ...(explicitStartTimeFilter ?? []),
      ...extractStartTimeFilters(filterState),
    ];
  }, [explicitStartTimeFilter, refiningFilter, oldFilterState]);

  // Fetch filter options
  const filterOptions = api.events.filterOptions.useQuery(
    {
      projectId,
      startTimeFilter:
        startTimeFilters.length > 0 ? startTimeFilters : undefined,
      hasParentObservation,
    },
    {
      trpc: {
        context: {
          skipBatch: true,
        },
      },
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: Infinity,
      // Keep showing previous options while fetching new ones to avoid sidebar flicker
      // TODO: maybe remove b/c unnecessary?
      placeholderData: (prev) => prev,
    },
  );

  // Transform filter options for sidebar
  const newFilterOptions = useMemo(() => {
    const scoreCategories =
      filterOptions.data?.score_categories?.reduce(
        (acc, score) => {
          acc[score.label] = score.values;
          return acc;
        },
        {} as Record<string, string[]>,
      ) ?? undefined;

    const scoresNumeric = filterOptions.data?.scores_avg ?? undefined;
    const traceScoreCategories =
      filterOptions.data?.trace_score_categories?.reduce(
        (acc, score) => {
          acc[score.label] = score.values;
          return acc;
        },
        {} as Record<string, string[]>,
      ) ?? undefined;
    const traceScoresNumeric =
      filterOptions.data?.trace_scores_avg ?? undefined;

    return {
      environment: filterOptions.data?.environment ?? undefined,
      name: filterOptions.data?.name ?? undefined,
      type: filterOptions.data?.type ?? undefined,
      level: filterOptions.data?.level ?? undefined,
      providedModelName: filterOptions.data?.providedModelName ?? undefined,
      modelId: filterOptions.data?.modelId ?? undefined,
      promptName: filterOptions.data?.promptName ?? undefined,
      traceTags: filterOptions.data?.traceTags ?? undefined,
      traceName: filterOptions.data?.traceName ?? undefined,
      userId: filterOptions.data?.userId ?? undefined,
      sessionId: filterOptions.data?.sessionId ?? undefined,
      version: filterOptions.data?.version ?? undefined,
      experimentDatasetId: filterOptions.data?.experimentDatasetId ?? undefined,
      experimentId: filterOptions.data?.experimentId ?? undefined,
      experimentName: filterOptions.data?.experimentName ?? undefined,
      hasParentObservation:
        filterOptions.data?.hasParentObservation ?? undefined,
      toolNames: filterOptions.data?.toolNames ?? undefined,
      calledToolNames: filterOptions.data?.calledToolNames ?? undefined,
      toolDefinitions: [],
      toolCalls: [],
      latency: [],
      timeToFirstToken: [],
      tokensPerSecond: [],
      inputTokens: [],
      outputTokens: [],
      totalTokens: [],
      inputCost: [],
      outputCost: [],
      totalCost: [],
      score_categories: scoreCategories,
      scores_avg: scoresNumeric,
      trace_score_categories: traceScoreCategories,
      trace_scores_avg: traceScoresNumeric,
    };
  }, [filterOptions.data]);

  return {
    filterOptions: newFilterOptions,
    isFilterOptionsPending: filterOptions.isPending,
    /**
     * Upstream-compatible approximate total observation count. Always `null`
     * here: this fork's `events.filterOptions` endpoint does not compute an
     * approximate count, and `null` is upstream's own "not available yet"
     * value, so consumers keep their existing "no count" rendering.
     */
    approxTotalCount: null as number | null,
    /**
     * Upstream-compatible per-column error set. There is no per-column fetch in
     * this fork — either the single bulk query succeeds or it does not — so
     * this is always empty and no facet is reported as errored.
     */
    erroredColumns: EMPTY_COLUMN_SET,
    /**
     * Upstream-compatible lazy-mode loading set. `undefined` in this fork, which
     * is upstream's value when no lazy mode is active (nothing is ever only
     * partially loaded).
     */
    loadingColumns: undefined as ReadonlySet<string> | undefined,
    /** Upstream-compatible lazy-mode column request; a no-op in this fork. */
    requestColumns: noopRequestColumns,
  };
}
