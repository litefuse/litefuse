import { api } from "@/src/utils/api";
import {
  type TableViewPresetTableName,
  type FilterState,
  type OrderByState,
  type TableViewPresetState,
  type ColumnDefinition,
} from "@langfuse/shared";
import { type DefaultViewScope } from "@langfuse/shared/src/server";
import { useKeyedSessionStorageState } from "@/src/features/filters/hooks/useKeyedSessionStorageState";
import { useRouter } from "next/router";
import { useEffect, useCallback, useState, useRef } from "react";
import { type VisibilityState } from "@tanstack/react-table";
import { StringParam, type UrlUpdateType } from "use-query-params";
import useSessionStorage from "@/src/components/useSessionStorage";
import { useQueryParam } from "use-query-params";
import { type LangfuseColumnDef } from "@/src/components/table/types";
import { showErrorToast } from "@/src/features/notifications/showErrorToast";
import isEqual from "lodash/isEqual";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";
import { validateOrderBy, validateFilters } from "../validation";
import { isSystemPresetId } from "../components/data-table-view-presets-drawer";

interface TableStateUpdaters {
  // ── Added for the evaluators v2 migration (ported from upstream) ───────────
  setExpandedFilters?: (expandedFilters: string[]) => void;
  setColumnOrder: (columnOrder: string[]) => void;
  setColumnVisibility: (columnVisibility: VisibilityState) => void;
  setOrderBy?: (orderBy: OrderByState) => void;
  setFilters?: (filters: FilterState) => void;
  setSearchQuery?: (searchQuery: string) => void;
}

interface UseTableStateProps {
  tableName: TableViewPresetTableName;
  projectId: string;
  stateUpdaters: TableStateUpdaters;
  validationContext?: {
    columns?: LangfuseColumnDef<any, any>[];
    filterColumnDefinition?: ColumnDefinition[];
    expandableFilterColumns?: string[];
  };
  currentFilterState?: FilterState;
  // ── Added for the evaluators v2 migration (ported from upstream) ───────────
  currentExpandedFilters?: string[];
  /** Suppresses all view work; the hook returns a settled, empty state. */
  disabled?: boolean;
  allowBackendSystemPresets?: boolean;
  /** Called after an application even when the validated state is unchanged. */
  onViewApplied?: (state: TableViewPresetState) => void;
  /** Reset transient table state on selection; preserve bookmarked pagination. */
  onViewSelected?: () => void;
}

/**
 * How a saved view / preset apply was initiated — the `trigger` analytics
 * dimension upstream records on `saved_views:applied` (ported for the
 * evaluators v2 migration).
 */
type SavedViewApplyTrigger =
  | "select"
  | "permalink"
  | "default"
  | "system_preset"
  | "system_preset_cleared";

export type SavedViewApplyMeta = {
  trigger: SavedViewApplyTrigger;
  viewId?: string | null;
};

/**
 * Hook to manage table view state with permalink support
 */
export function useTableViewManager({
  projectId,
  tableName,
  stateUpdaters,
  validationContext = {},
  currentFilterState,
  currentExpandedFilters: _currentExpandedFilters,
  disabled = false,
  allowBackendSystemPresets = false,
  onViewApplied,
  onViewSelected: _onViewSelected,
}: UseTableStateProps) {
  const router = useRouter();
  const isRouterReady = router.isReady;
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const capture = usePostHogClientCapture();
  // ── Added for the evaluators v2 migration (ported from upstream) ───────────
  // Set while a view is applied so the bootstrap effect can tell "the user
  // edited a working view" (view stays deselected) from "nothing to restore".
  const [viewUpdateTarget, setViewUpdateTarget] = useKeyedSessionStorageState<{
    viewId: string;
    columnsApplied: boolean;
  } | null>(`${tableName}-${projectId}-viewUpdateTarget`, null);
  // Bumped whenever a view is applied: applying a view discards filter drafts.
  const [filterEditorResetKey, setFilterEditorResetKey] = useState(0);
  const pendingFiltersRef = useRef<FilterState | null>(null);
  const pendingFiltersPreviousStateRef = useRef<FilterState | null>(null);

  const [storedViewId, setStoredViewId] = useSessionStorage<string | null>(
    `${tableName}-${projectId}-viewId`,
    null,
  );
  const [selectedViewIdParam, setSelectedViewId] = useQueryParam(
    "viewId",
    StringParam,
  );
  const selectedViewId = selectedViewIdParam ?? null;
  const selectedViewIdRef = useRef<string | null>(selectedViewId);
  const storedViewIdRef = useRef(storedViewId);
  storedViewIdRef.current = storedViewId;
  selectedViewIdRef.current = selectedViewId;
  const isInitializedRef = useRef(isInitialized);
  isInitializedRef.current = isInitialized;

  // Query for resolved default view (user > project > null)
  const { data: resolvedDefault, isLoading: isDefaultLoading } =
    api.TableViewPresets.getDefault.useQuery(
      { projectId, viewName: tableName },
      {
        enabled: !!projectId,
        staleTime: 5 * 60 * 1000, // Cache for 5 minutes
      },
    );

  // Keep track of the viewId in session storage and in the query params
  const handleSetViewId = useCallback(
    (viewId: string | null, options?: { updateType?: UrlUpdateType }) => {
      selectedViewIdRef.current = viewId;
      storedViewIdRef.current = viewId;
      setViewUpdateTarget(null);
      setStoredViewId(viewId);
      setSelectedViewId(viewId, options?.updateType);

      // Explicitly selecting "My view (default)" should stop bootstrap restore.
      // Otherwise an in-flight bootstrap can restore a previously selected view.
      if (viewId === null && !isInitializedRef.current) {
        isInitializedRef.current = true;
        setIsInitialized(true);
        setIsLoading(false);
      }
    },
    [setStoredViewId, setSelectedViewId, setViewUpdateTarget],
  );

  /**
   * Reacts to a user edit of the live table state (a filter, a search string,
   * a column move). Applying the edit deselects the saved view — with `replaceIn`
   * so the pre-edit URL does not survive as a Back-able history entry — and
   * records the view that was being edited so the rows can be re-derived.
   * Ported from upstream (decision T1).
   */
  const handleUserStateChange = useCallback(
    (
      previousValue: unknown,
      nextValue: unknown,
      options?: { force?: boolean },
    ) => {
      const viewId = selectedViewIdRef.current;
      if (!viewId || (!options?.force && isEqual(previousValue, nextValue)))
        return;
      const columnsApplied = storedViewIdRef.current === viewId;
      handleSetViewId(null, { updateType: "replaceIn" });
      setViewUpdateTarget({ viewId, columnsApplied });
    },
    [handleSetViewId, setViewUpdateTarget],
  );

  // Extract updater functions and store in refs to avoid stale closures
  const {
    setOrderBy,
    setFilters,
    setColumnOrder,
    setColumnVisibility,
    setSearchQuery,
  } = stateUpdaters;

  // Use refs to always get latest function references to avoid stale closures in applyViewState
  // for restoring view state from the saved views
  const setFiltersRef = useRef(setFilters);
  const setOrderByRef = useRef(setOrderBy);
  const setSearchQueryRef = useRef(setSearchQuery);
  const onViewAppliedRef = useRef(onViewApplied);

  // Update refs immediately on every render
  setFiltersRef.current = setFilters;
  setOrderByRef.current = setOrderBy;
  setSearchQueryRef.current = setSearchQuery;
  onViewAppliedRef.current = onViewApplied;

  // Extract primitive for effect dep (rerender-dependencies: avoid object deps)
  const defaultViewId = resolvedDefault?.viewId;

  // Single resolve effect: walk priority list and either return early (pending) or initialize.
  // `selectedViewId` (use-query-params state) is the single source of truth for bootstrap/fetch.
  useEffect(() => {
    if (isInitialized) return;
    if (!isRouterReady) return;

    // If viewId already in URL and not a system preset → getById query handles it.
    // Sync to session storage so navigating away and back restores the view.
    if (selectedViewId && !isSystemPresetId(selectedViewId)) {
      if (storedViewId !== selectedViewId) {
        setStoredViewId(selectedViewId);
      }
      return;
    }

    // Clear stale system preset from URL (e.g. navigated from session detail).
    if (selectedViewId && isSystemPresetId(selectedViewId)) {
      handleSetViewId(null);
      return;
    }

    // Priority 1: Session storage (from a previous visit to this table)
    // An edited working view stays deselected on reload, including empty filters.
    if (!selectedViewId && viewUpdateTarget) {
      setIsInitialized(true);
      setIsLoading(false);
      return;
    }

    if (storedViewId && !isSystemPresetId(storedViewId)) {
      setSelectedViewId(storedViewId);
      return;
    }

    // Priority 2: Default view (wait for query to resolve)
    if (isDefaultLoading) return;

    if (defaultViewId) {
      if (isSystemPresetId(defaultViewId)) {
        // Resolved defaults should never point to system presets; clear if they do.
        handleSetViewId(null);
        return;
      }
      setStoredViewId(defaultViewId);
      setSelectedViewId(defaultViewId);
      return;
    }

    // Priority 3: Nothing to apply
    setIsInitialized(true);
    setIsLoading(false);
  }, [
    isInitialized,
    isRouterReady,
    selectedViewId,
    storedViewId,
    isDefaultLoading,
    defaultViewId,
    viewUpdateTarget,
    handleSetViewId,
    setStoredViewId,
    setSelectedViewId,
  ]);

  // Method to apply state from a view
  const applyViewState = useCallback(
    (viewData: TableViewPresetState) => {
      // lock table
      setIsLoading(true);

      /**
       * Validate orderBy and filters
       */
      let validOrderBy: OrderByState | null = null;
      let validFilters: FilterState = [];
      if (viewData.orderBy) {
        validOrderBy = validateOrderBy(
          viewData.orderBy,
          validationContext.columns,
        );
      }

      // Validate and apply filters
      if (viewData.filters) {
        validFilters = validateFilters(
          viewData.filters,
          validationContext.filterColumnDefinition,
        );
      }

      if (
        !isEqual(validOrderBy, viewData.orderBy) ||
        validFilters.length !== viewData.filters.length
      ) {
        showErrorToast(
          "Outdated view",
          "This view is outdated. Some old filters or ordering may have been ignored. Please update your view.",
          "WARNING",
        );
      }

      if (setOrderByRef.current) setOrderByRef.current(validOrderBy);

      const filtersAlreadyApplied = isEqual(currentFilterState, validFilters);

      if (setFiltersRef.current) {
        setFiltersRef.current(validFilters);
        // Track expected filters to observe when state actually updates (for useEffect below)
        // If filters are already applied, don't set pending ref (will unlock immediately).
        // Also track pre-apply state so we can unlock when filters propagate but get
        // canonicalized into an equivalent shape by downstream hooks.
        if (!filtersAlreadyApplied) {
          pendingFiltersRef.current = validFilters;
          pendingFiltersPreviousStateRef.current = currentFilterState ?? [];
        }
      }

      // Handle search query (only set if non-empty to avoid use-query-params batching conflicts)
      if (viewData.searchQuery && setSearchQueryRef.current) {
        setSearchQueryRef.current(viewData.searchQuery);
      }

      // Apply column order and visibility without validation since UI will handle gracefully
      if (viewData.columnOrder) setColumnOrder(viewData.columnOrder);
      if (viewData.columnVisibility)
      // Applying a view discards drafts; leaving a view while editing preserves them.
      setFilterEditorResetKey((key) => key + 1);
      onViewAppliedRef.current?.({
        ...viewData,
        filters: validFilters,
        orderBy: validOrderBy,
        searchQuery: viewData.searchQuery || null,
      });
        setColumnVisibility(viewData.columnVisibility);

      // If filters were already applied, unlock table immediately
      if (filtersAlreadyApplied) {
        setIsLoading(false);
      }

      // NOTE: Table remains locked until useEffect observer detects filter state propagation
      // This is relevant for the saved views. Because the URL lazy updates and we don't want to wait
      // for a page reload
    },
    [
      setColumnOrder,
      setColumnVisibility,
      validationContext,
      currentFilterState,
    ],
  );

  // Fetch view data if viewId is provided (skip for system presets)
  const {
    data: selectedViewData,
    error: selectedViewError,
    isSuccess: isSelectedViewSuccess,
    isError: isSelectedViewError,
  } = api.TableViewPresets.getById.useQuery(
    { viewId: selectedViewId as string, projectId },
    {
      enabled:
        isRouterReady &&
        !!selectedViewId &&
        !isInitialized &&
        !isSystemPresetId(selectedViewId),
    },
  );

  useEffect(() => {
    if (!isSelectedViewSuccess || !selectedViewData) return;
    const requestedViewId = selectedViewId;
    if (!requestedViewId) return;
    if (isInitializedRef.current) return;
    if (selectedViewIdRef.current !== requestedViewId) return;
    if (selectedViewData.id !== requestedViewId) return;

    // Track permalink visit
    capture("saved_views:permalink_visit", {
      tableName,
      viewId: requestedViewId,
      name: selectedViewData.name,
    });

    applyViewState(selectedViewData);
    isInitializedRef.current = true;
    setIsInitialized(true);
  }, [
    isSelectedViewSuccess,
    selectedViewData,
    selectedViewId,
    capture,
    tableName,
    applyViewState,
  ]);

  useEffect(() => {
    if (!isSelectedViewError || !selectedViewError) return;
    const requestedViewId = selectedViewId;
    if (!requestedViewId) return;
    if (isInitializedRef.current) return;
    if (selectedViewIdRef.current !== requestedViewId) return;

    isInitializedRef.current = true;
    setIsInitialized(true);
    setIsLoading(false);
    handleSetViewId(null);
    showErrorToast("Error applying view", selectedViewError.message, "WARNING");
  }, [isSelectedViewError, selectedViewError, selectedViewId, handleSetViewId]);

  // Observe when filter state propagates from saved view
  // After calling setFilters, URL updates async → filterState recalculates → this effect detects completion
  useEffect(() => {
    const pendingFilters = pendingFiltersRef.current;
    if (!pendingFilters || currentFilterState === undefined) return;

    const preApplyFilters = pendingFiltersPreviousStateRef.current ?? [];
    const hasExpectedShape = isEqual(currentFilterState, pendingFilters);
    const hasPropagatedWithCanonicalization = !isEqual(
      currentFilterState,
      preApplyFilters,
    );

    if (hasExpectedShape || hasPropagatedWithCanonicalization) {
      // Filter state has synchronized - safe to unlock table.
      // `hasPropagatedWithCanonicalization` handles equivalent rewrites
      // (for example legacy env-delta -> canonical none-of shape).
      pendingFiltersRef.current = null;
      pendingFiltersPreviousStateRef.current = null;
      setIsLoading(false);
    }
  }, [currentFilterState]);

  if (disabled) {
    return {
      isLoading: false,
      applyViewState: () => {},
      handleSetViewId: () => {},
      handleUserStateChange: () => {},
      filterEditorResetKey: 0,
      viewUpdateTarget: null,
      selectedViewId: null,
      appliedViewId: null,
      defaultViewScope: null,
    };
  }

  return {
    isLoading,
    applyViewState,
    handleSetViewId,
    handleUserStateChange,
    filterEditorResetKey,
    viewUpdateTarget,
    selectedViewId,
    // The view whose state is reflected in the live table (see upstream's note).
    appliedViewId: storedViewId,
    defaultViewScope: resolvedDefault?.scope as DefaultViewScope | null,
  };
}
