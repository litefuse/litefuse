/* eslint-disable no-nested-ternary */
import { showSuccessToast } from "@/src/features/notifications";
import { formatDistanceToNowStrict } from "date-fns";
import {
  type OrderByState,
  TableViewPresetTableName,
  ZodModelConfig,
} from "@langfuse/shared";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { type ComponentProps, useMemo, useRef, useState } from "react";
import { StringParam, useQueryParam, withDefault } from "use-query-params";
import { useStore } from "zustand";
import Page from "@/src/components/layouts/page";
import { DataTable } from "@/src/components/table/data-table";
import { useRowHeightLocalStorage } from "@/src/components/table/data-table-row-height-switch";
import { DataTableToolbar } from "@/src/components/table/data-table-toolbar";
import {
  DataTableControls,
  DataTableControlsProvider,
} from "@/src/components/table/data-table-controls";
import { ResizableFilterLayout } from "@/src/components/table/resizable-filter-layout";
import type { LangfuseColumnDef } from "@/src/components/table/types";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { EvaluatorsEmptyState } from "../components/EvaluatorsEmptyState/EvaluatorsEmptyState";
import { PopoverTrigger } from "@/src/components/ui/popover";
import { Skeleton } from "@/src/components/ui/skeleton";
import { EvaluatorActionsCell } from "../components/Evaluators/EvaluatorActionsCell/EvaluatorActionsCell";
import { EvaluatorBulkDeleteDialog } from "../components/Evaluators/EvaluatorBulkDeleteDialog/EvaluatorBulkDeleteDialog";
import { EvaluatorGalleryDialog } from "../components/EvaluatorGalleryDialog/EvaluatorGalleryDialog";
import { EvaluatorStatusBadge } from "../components/Evaluators/EvaluatorStatusBadge/EvaluatorStatusBadge";
import { EvaluatorTypeBadge } from "../components/Evaluators/EvaluatorTypeBadge/EvaluatorTypeBadge";
import { EvaluatorExecutionHistory } from "@/src/features/evals/v2/components/Rules/EvaluatorExecutionHistory/EvaluatorExecutionHistory";
import { OverviewSelectionBar } from "../components/OverviewSelectionBar/OverviewSelectionBar";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics";
import {
  useColumnOrder,
  useColumnVisibility,
} from "@/src/features/column-visibility";
import { useHasProjectAccess } from "@/src/features/rbac";
import { useEvaluatorAlerts } from "@/src/features/evals/v2/hooks/useEvaluatorAlerts";
import { TableSelectionManager } from "@/src/features/table";
import { usePaginationState } from "@/src/hooks/usePaginationState";
import { useSidebarFilterState } from "@/src/features/filters";
import { TableSearchBar, toObservedOptions } from "@/src/features/search-bar";

import { EVALUATORS_LIST_FIELD_REGISTRY } from "../constants/tableSearchRegistry";
import { useTableViewManager } from "@/src/components/table/table-view-presets/hooks/useTableViewManager";
import {
  createEvaluatorsTableStore,
  type EvaluatorsTableStore,
} from "../store/evaluatorsTableStore";
import { api, type RouterInputs, type RouterOutputs } from "@/src/utils/api";
import { trpcErrorToast } from "@/src/utils/trpcErrorToast";
import {
  evaluatorExecutionsUrl,
  evaluatorScoresUrl,
} from "../fns/evaluators/evaluatorScoresUrl";
import { ruleTracesUrl } from "../fns/rules/ruleLinkUrls";
import { EVALS_V2_TABS, getEvalsV2Tabs } from "@/src/features/navigation";
import { DefaultModelChangeConfirmationDialog } from "../components/Evaluators/ProjectDefaultModel/DefaultModelChangeConfirmationDialog";
import { useProjectDefaultModel } from "@/src/features/evals/v2/hooks/useProjectDefaultModel";
import {
  JudgeModelPicker,
  JudgeModelPickerTrigger,
} from "../components/Evaluators/JudgeModelPicker/JudgeModelPicker";
import { JudgeModelConfigurationDialog } from "../components/Evaluators/JudgeModelConfigurationDialog/JudgeModelConfigurationDialog";
import {
  evaluatorTableFilterColumns,
  evaluatorTableFilterConfig,
  evaluatorTableFilterOptions,
} from "../constants/tableFilterColumns";
import type { GalleryTemplate } from "../types/templateGallery";
import { V4MigrationUpdateRequiredBadge } from "@/src/features/v4-migration/V4MigrationDelayBadge";
import { useOrderByState } from "@/src/features/orderBy";
import { createUserTableColumn } from "@/src/components/design-system/table/columns/createUserTableColumn";
import { EvaluatorAlertButton } from "@/src/features/evals/v2/components/Evaluators/EvaluatorAlertButton/EvaluatorAlertButton";

type EvaluatorRow = RouterOutputs["evalsV2"]["list"]["evaluators"][number];

function evaluatorCreateHref(projectId: string, template: GalleryTemplate) {
  return template.source === "managed"
    ? `/project/${projectId}/evals/new?template=${encodeURIComponent(template.key)}`
    : `/project/${projectId}/evals/new?evaluatorId=${encodeURIComponent(template.id)}`;
}

function RelativeDate({ date }: { date: Date }) {
  return (
    <span className="text-muted-foreground" title={date.toLocaleString()}>
      {formatDistanceToNowStrict(date, { addSuffix: true })}
    </span>
  );
}

function EvaluatorsOverviewSelectionBar({
  selectionStore,
  totalCount,
  canDelete,
  onDeleteSelection,
}: {
  selectionStore: EvaluatorsTableStore;
  totalCount: number | null;
  /** `evaluator:CUD`. Viewers may select rows but never see the delete action. */
  canDelete: boolean;
  onDeleteSelection: (selection: {
    selectAll: boolean;
    selectedIds: string[];
  }) => void;
}) {
  const { t } = useTranslation();
  const rowSelection = useStore(selectionStore, (state) => state.rowSelection);
  const selectAll = useStore(selectionStore, (state) => state.selectAll);
  const selectedIds = Object.keys(rowSelection).filter(
    (id) => rowSelection[id],
  );

  return (
    <OverviewSelectionBar
      selectedCount={
        selectAll ? (totalCount ?? selectedIds.length) : selectedIds.length
      }
      onClear={selectionStore.getState().actions.clearSelection}
    >
      {canDelete ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => onDeleteSelection({ selectAll, selectedIds })}
        >
          <Trash2 className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">{t("Delete")}</span>
        </Button>
      ) : null}
    </OverviewSelectionBar>
  );
}

function EvaluatorsTableToolbar({
  selectionStore,
  pageRowIds,
  pageSize,
  pageIndex,
  totalCount,
  ...toolbarProps
}: Omit<
  ComponentProps<typeof DataTableToolbar<EvaluatorRow, unknown>>,
  "multiSelect"
> & {
  selectionStore: EvaluatorsTableStore;
  pageRowIds: string[];
  pageSize: number;
  pageIndex: number;
  totalCount: number | null;
}) {
  const rowSelection = useStore(selectionStore, (state) => state.rowSelection);
  const selectAll = useStore(selectionStore, (state) => state.selectAll);
  const selectionActions = selectionStore.getState().actions;
  const selectedPageRowIds = pageRowIds.filter((id) => rowSelection[id]);

  return (
    <DataTableToolbar
      tableName="evaluators-v2"
      {...toolbarProps}
      multiSelect={{
        selectAll,
        setSelectAll: selectionActions.setSelectAll,
        selectedRowIds: selectedPageRowIds,
        setRowSelection: selectionActions.setRowSelection,
        pageSize,
        pageIndex,
        totalCount,
      }}
    />
  );
}

export default function EvaluatorsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const capture = usePostHogClientCapture();
  const projectId = router.query.projectId as string;
  const evaluatorAlerts = useEvaluatorAlerts({
    scope: "allEvaluators",
    projectId,
  });
  const projectDefaultModel = useProjectDefaultModel({
    projectId,
    source: "overview",
  });
  const [pagination, setPagination] = usePaginationState(1, 50);
  const [orderBy, setOrderBy] = useOrderByState({
    column: "updatedAt",
    order: "DESC",
  });
  const [rowHeight, setRowHeight] = useRowHeightLocalStorage(
    "evaluatorsV2",
    "s",
  );
  const [searchQuery, setSearchQuery] = useQueryParam(
    "search",
    withDefault(StringParam, null),
  );
  const [selectionStore] = useState(() => createEvaluatorsTableStore());
  const filterOptionsQuery = api.evalsV2.filterOptions.useQuery(
    { projectId },
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
      staleTime: Infinity,
    },
  );
  const filterOptions = useMemo(
    () => ({
      ...evaluatorTableFilterOptions,
      name: filterOptionsQuery.data?.name ?? [],
      creator: filterOptionsQuery.data?.creator ?? [],
      model: filterOptionsQuery.data?.model ?? [],
    }),
    [filterOptionsQuery.data],
  );
  const filterConfig = useMemo(
    () => ({
      ...evaluatorTableFilterConfig,
      facets: evaluatorTableFilterConfig.facets.map((facet) =>
        facet.column === "model"
          ? {
              ...facet,
              renderOptionSuffix: (model: string) =>
                model === projectDefaultModel.defaultModel?.model ? (
                  <Badge variant="secondary">{t("Project default")}</Badge>
                ) : null,
            }
          : facet,
      ),
    }),
    [projectDefaultModel.defaultModel?.model, t],
  );
  const viewControllersRef = useRef<Pick<
    ReturnType<typeof useTableViewManager>,
    "handleUserStateChange"
  > | null>(null);
  const queryFilter = useSidebarFilterState(filterConfig, filterOptions, {
    loading: filterOptionsQuery.isPending,
    stateLocation: "urlAndSessionStorage",
    sessionFilterContextId: projectId,
    onExplicitFilterStateChange: (change) => {
      if (change.origin === "user") {
        viewControllersRef.current?.handleUserStateChange(
          change.previousFilters,
          change.nextFilters,
          { force: change.action === "clear" },
        );
      }
      setPagination({ page: 1, limit: pagination.limit });
      selectionStore.getState().actions.clearSelection();
    },
  });
  const filterState = queryFilter.filterState;
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [deleteAll, setDeleteAll] = useState(false);
  const [gallery, setGallery] = useQueryParam(
    "gallery",
    withDefault(StringParam, null),
  );
  const galleryOpen = gallery === "open";
  const setGalleryOpen = (open: boolean) => {
    setGallery(open ? "open" : null, "replaceIn");
  };
  const [defaultModelPickerOpen, setDefaultModelPickerOpen] = useState(false);
  const [defaultModelConfigurationOpen, setDefaultModelConfigurationOpen] =
    useState(false);
  const evaluators = api.evalsV2.list.useQuery(
    {
      projectId,
      ...pagination,
      orderBy: orderBy
        ? (orderBy as RouterInputs["evalsV2"]["list"]["orderBy"])
        : undefined,
      search: searchQuery ?? undefined,
      filter: filterState,
    },
    { enabled: Boolean(projectId) },
  );
  const evaluatorIds = useMemo(
    () => evaluators.data?.evaluators.map(({ id }) => id) ?? [],
    [evaluators.data?.evaluators],
  );
  const showOnboarding =
    evaluators.isSuccess &&
    evaluators.data.totalItems === 0 &&
    !searchQuery &&
    filterState.length === 0;
  const hasExecutionReadAccess = useHasProjectAccess({
    projectId,
    scope: "evalJobExecution:read",
  });
  // Create / edit / clone / delete all need `evaluator:CUD`. Hiding the entries
  // is better than letting a viewer click them into a FORBIDDEN toast.
  const hasEvaluatorWriteAccess = useHasProjectAccess({
    projectId,
    scope: "evaluator:CUD",
  });
  const defaultModelConnection = projectDefaultModel.connections.find(
    ({ provider }) => provider === projectDefaultModel.defaultModel?.provider,
  );
  const parsedDefaultModelParams = ZodModelConfig.safeParse(
    projectDefaultModel.defaultModel?.modelParams,
  );
  const defaultModelConfig =
    projectDefaultModel.defaultModel && defaultModelConnection
      ? {
          provider: projectDefaultModel.defaultModel.provider,
          model: projectDefaultModel.defaultModel.model,
          adapter: defaultModelConnection.adapter,
          modelParams: parsedDefaultModelParams.success
            ? parsedDefaultModelParams.data
            : {},
        }
      : null;
  const recentExecutions = api.evalsV2.recentExecutions.useQuery(
    { projectId, evaluatorIds },
    {
      enabled: hasExecutionReadAccess && evaluatorIds.length > 0,
      meta: { silentHttpCodes: [503] },
    },
  );
  // What "View traces" / "View scores" need per evaluator: the rules it is
  // attached to (each carrying its own filter) and the score names it wrote.
  const linkTargets = api.evalsV2.linkTargets.useQuery(
    { projectId, evaluatorIds },
    { enabled: evaluatorIds.length > 0, meta: { silentHttpCodes: [503] } },
  );
  const utils = api.useUtils();
  const deleteMany = api.evalsV2.deleteMany.useMutation({
    onError: trpcErrorToast,
    onSuccess: async () => {
      selectionStore.getState().actions.clearSelection();
      setDeleteIds([]);
      setDeleteAll(false);
      const deletedCount = deleteAll
        ? (evaluators.data?.totalItems ?? 0)
        : deleteIds.length;
      capture("evaluators:delete", {
        source: "overview",
        evaluatorCount: deletedCount,
        isAllMatching: deleteAll,
      });
      showSuccessToast({
        title: t("Evaluators deleted"),
        description:
          deletedCount === 1
            ? t("{{count}} evaluator deleted.", { count: deletedCount })
            : t("{{count}} evaluators deleted.", { count: deletedCount }),
      });
      await Promise.all([
        utils.evalsV2.list.invalidate({ projectId }),
        utils.evalsV2.filterOptions.invalidate({ projectId }),
      ]);
    },
  });

  const { selectActionColumn } = TableSelectionManager<EvaluatorRow>({
    projectId,
    tableName: "evaluators-v2",
    setSelectedRows: selectionStore.getState().actions.setRowSelection,
    setSelectAll: selectionStore.getState().actions.setSelectAll,
    selectionStore,
  });
  const columns = useMemo<LangfuseColumnDef<EvaluatorRow>[]>(
    () => [
      selectActionColumn,
      {
        accessorKey: "name",
        id: "name",
        header: t("Name"),
        size: 320,
        isFixedPosition: true,
        enableSorting: true,
        cell: ({ row }) => (
          <span className="block truncate font-bold" title={row.original.name}>
            {row.original.name}
          </span>
        ),
      },
      {
        accessorKey: "status",
        id: "status",
        header: t("Status"),
        size: 130,
        enableHiding: true,
        cell: ({ row }) => (
          <EvaluatorStatusBadge
            ruleCount={row.original._count.assignments}
            active={row.original.hasActiveRules}
            blocked={Boolean(row.original.blockedAt)}
            blockReason={row.original.blockReason}
            blockMessage={row.original.blockMessage}
          />
        ),
      },
      {
        accessorKey: "executionTraces",
        id: "executionTraces",
        header: t("Last 5 runs"),
        size: 130,
        enableHiding: true,
        cell: ({ row }) => {
          if (recentExecutions.isPending && hasExecutionReadAccess) {
            return <Skeleton className="h-4 w-16" />;
          }
          const history = (
            <EvaluatorExecutionHistory
              traces={recentExecutions.data?.[row.original.id] ?? []}
            />
          );
          return hasExecutionReadAccess ? (
            <button
              type="button"
              className="focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:outline-none"
              aria-label={t("View executions for {{name}}", {
                name: row.original.name,
              })}
              onClick={(event) => {
                // The run markers are a drill-down inside the row; without this
                // the row's own onClick also fires and the evaluator detail page
                // wins the navigation race against this executions link.
                event.stopPropagation();
                router.push(
                  evaluatorExecutionsUrl(
                    projectId,
                    row.original.name,
                    row.original.type,
                  ),
                );
              }}
            >
              {history}
            </button>
          ) : (
            history
          );
        },
      },
      {
        accessorKey: "type",
        id: "type",
        header: t("Type"),
        size: 160,
        enableHiding: true,
        enableSorting: true,
        cell: ({ row }) => <EvaluatorTypeBadge type={row.original.type} />,
      },
      // The "Total cost (7d)" column was removed: the cost reader returns no
      // real numbers in this deployment, so it only ever rendered an empty
      // placeholder. Restore it from git history if the reader starts
      // returning data again.
      {
        accessorKey: "model",
        id: "model",
        header: t("Model"),
        size: 180,
        enableHiding: true,
        cell: ({ row }) => {
          const model = row.original.effectiveModel;
          return model ? (
            <span className="block truncate" title={model}>
              {model}
            </span>
          ) : (
            "—"
          );
        },
      },
      createUserTableColumn<EvaluatorRow>({
        accessorKey: "createdByUser",
        header: t("Created by"),
        size: 180,
        enableHiding: true,
        variant: "text",
        emptyValue: "API",
      }),
      {
        accessorKey: "createdAt",
        id: "createdAt",
        header: t("Created at"),
        size: 180,
        enableHiding: true,
        defaultHidden: true,
        enableSorting: true,
        cell: ({ row }) => <RelativeDate date={row.original.createdAt} />,
      },
      {
        accessorKey: "updatedAt",
        id: "updatedAt",
        header: t("Updated at"),
        size: 180,
        enableHiding: true,
        enableSorting: true,
        cell: ({ row }) => <RelativeDate date={row.original.updatedAt} />,
      },
      {
        accessorKey: "actions",
        id: "actions",
        header: t("Actions"),
        size: 170,
        isFixedPosition: true,
        enableSorting: false,
        enableResizing: false,
        cell: ({ row }) => {
          const target = linkTargets.data?.[row.original.id];
          const scoresUrl = evaluatorScoresUrl({
            projectId,
            scoreNames: target?.scoreNames ?? [],
          });
          // An evaluator is evaluated BY rules and has no filter of its own, so
          // its "View traces" is per rule: one rule goes straight there, several
          // open a picker (see EvaluatorActionsCell).
          const ruleTracesLinks = (target?.rules ?? []).map((rule) => ({
            ruleId: rule.id,
            ruleName: rule.name,
            href: ruleTracesUrl({ projectId, filter: rule.filter }),
          }));

          return (
            <div className="w-full" onClick={(event) => event.stopPropagation()}>
              <EvaluatorActionsCell
                canEdit={hasEvaluatorWriteAccess}
                canViewExecutions={hasExecutionReadAccess}
                canViewScores={scoresUrl !== null}
                ruleTracesLinks={ruleTracesLinks}
                onViewScores={() => {
                  if (!scoresUrl) return;
                  router.push(scoresUrl);
                }}
                onViewExecutions={() =>
                  router.push(
                    evaluatorExecutionsUrl(
                      projectId,
                      row.original.name,
                      row.original.type,
                    ),
                  )
                }
                onEdit={() =>
                  router.push(`/project/${projectId}/evals/${row.original.id}`)
                }
                onClone={() =>
                  router.push(
                    `/project/${projectId}/evals/new?evaluatorId=${encodeURIComponent(row.original.id)}`,
                  )
                }
                onDelete={() => setDeleteIds([row.original.id])}
              />
            </div>
          );
        },
      },
    ],
    [
      hasEvaluatorWriteAccess,
      hasExecutionReadAccess,
      projectId,
      recentExecutions.data,
      recentExecutions.isPending,
      linkTargets.data,
      router,
      selectActionColumn,
      t,
    ],
  );
  const [columnVisibility, setColumnVisibility] =
    useColumnVisibility<EvaluatorRow>("evaluatorsV2ColumnVisibility", columns);
  const [columnOrder, setColumnOrder] = useColumnOrder<EvaluatorRow>(
    "evaluatorsV2ColumnOrder-v2",
    columns,
  );
  const setEvaluatorOrderBy = (nextOrderBy: OrderByState) => {
    setOrderBy(nextOrderBy);
    setPagination({ page: 1, limit: pagination.limit });
    selectionStore.getState().actions.clearSelection();
  };
  const { isLoading: isViewLoading, ...viewControllers } = useTableViewManager({
    tableName: TableViewPresetTableName.Evaluators,
    projectId,
    stateUpdaters: {
      setFilters: (filters) =>
        queryFilter.setFilterState(filters, { origin: "saved_view" }),
      setExpandedFilters: queryFilter.onExpandedChange,
      setSearchQuery: (query) => {
        setSearchQuery(query);
        setPagination({ page: 1, limit: pagination.limit });
        selectionStore.getState().actions.clearSelection();
      },
      setColumnOrder,
      setColumnVisibility,
      setOrderBy: setEvaluatorOrderBy,
    },
    validationContext: {
      columns,
      filterColumnDefinition: evaluatorTableFilterColumns,
      expandableFilterColumns: filterConfig.facets.map((facet) => facet.column),
    },
    currentFilterState: queryFilter.explicitFilterState,
    currentExpandedFilters: queryFilter.expanded,
  });
  viewControllersRef.current = viewControllers;

  const handleSearchChange = (query: string | null) => {
    viewControllers.handleUserStateChange(searchQuery ?? "", query ?? "");
    setSearchQuery(query);
    setPagination({ page: 1, limit: pagination.limit });
    selectionStore.getState().actions.clearSelection();
  };
  const handleOrderByChange = (next: OrderByState) => {
    viewControllers.handleUserStateChange(orderBy, next);
    setEvaluatorOrderBy(next);
  };
  const handleColumnOrderChange: typeof setColumnOrder = (updater) => {
    const next = typeof updater === "function" ? updater(columnOrder) : updater;
    viewControllers.handleUserStateChange(columnOrder, next);
    setColumnOrder(next);
  };
  const handleColumnVisibilityChange: typeof setColumnVisibility = (
    updater,
  ) => {
    const next =
      typeof updater === "function" ? updater(columnVisibility) : updater;
    viewControllers.handleUserStateChange(columnVisibility, next);
    setColumnVisibility(next);
  };

  return (
    <Page
      headerProps={{
        title: t("Evaluators"),
        titleBadges: <V4MigrationUpdateRequiredBadge />,
        help: {
          description: t(
            "Create reusable evaluator definitions and test them before activation.",
          ),
        },
        actionButtonsRight: (
          <div className="flex gap-2">
            {showOnboarding ? null : (
              <JudgeModelPicker
                purpose="projectDefault"
                open={defaultModelPickerOpen}
                defaultModel={projectDefaultModel.defaultModel}
                providerGroups={projectDefaultModel.providerGroups}
                onOpenChange={setDefaultModelPickerOpen}
                onSelectProjectDefault={(model) => {
                  const connection = projectDefaultModel.connections.find(
                    ({ provider }) => provider === model.provider,
                  );
                  if (!connection) return;
                  projectDefaultModel.update.requestUpdate({
                    ...model,
                    adapter: connection.adapter,
                    modelParams: {},
                  });
                }}
                onConfigureProviders={projectDefaultModel.openProviderSettings}
                onConfigureModel={() => setDefaultModelConfigurationOpen(true)}
                hasModelConfiguration={Boolean(
                  defaultModelConfig &&
                  Object.keys(defaultModelConfig.modelParams).length > 0,
                )}
              >
                <PopoverTrigger asChild>
                  <JudgeModelPickerTrigger
                    mode="default"
                    defaultModel={projectDefaultModel.defaultModel}
                    selectedModel={null}
                    missingDefaultLabel={t("Set project default model")}
                    loading={projectDefaultModel.update.isPending}
                    loadingText={t("Setting model...")}
                    disabled={
                      !projectDefaultModel.canUpdate ||
                      !projectDefaultModel.canRead ||
                      projectDefaultModel.connectionsPending ||
                      projectDefaultModel.update.isPending
                    }
                    borderVariant="contrast"
                  />
                </PopoverTrigger>
              </JudgeModelPicker>
            )}
            {showOnboarding ? null : (
              <EvaluatorAlertButton
                scope="allEvaluators"
                projectId={projectId}
                {...evaluatorAlerts}
                hideCreateEntryWhenEmpty
              />
            )}
            {hasEvaluatorWriteAccess ? (
              <Button onClick={() => setGalleryOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                {t("New evaluator")}
              </Button>
            ) : null}
          </div>
        ),
        tabsProps: {
          tabs: getEvalsV2Tabs(projectId),
          activeTab: EVALS_V2_TABS.EVALUATORS,
        },
      }}
    >
      {showOnboarding ? (
        <EvaluatorsEmptyState
          onSelectTemplate={(template) => {
            router.push(evaluatorCreateHref(projectId, template));
          }}
          onBrowseLibrary={() => setGalleryOpen(true)}
        />
      ) : (
        <DataTableControlsProvider tableName={filterConfig.tableName}>
          <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden">
            <TableSearchBar
              key={`${viewControllers.filterEditorResetKey}:${queryFilter.draftResetKey}`}
              projectId={projectId}
              tableName={filterConfig.tableName}
              registry={EVALUATORS_LIST_FIELD_REGISTRY}
              filterState={queryFilter.searchBarFilterState}
              setFilterState={queryFilter.setFilterState}
              observed={toObservedOptions(
                filterOptions,
                filterOptionsQuery.isPending,
              )}
              search={{
                query: searchQuery ?? null,
                setQuery: handleSearchChange,
              }}
              isV4={false}
            />
            <EvaluatorsTableToolbar
              selectionStore={selectionStore}
              pageRowIds={evaluatorIds}
              pageSize={pagination.limit}
              pageIndex={pagination.page - 1}
              totalCount={evaluators.data?.totalItems ?? null}
              columns={columns}
              columnVisibility={columnVisibility}
              setColumnVisibility={handleColumnVisibilityChange}
              columnOrder={columnOrder}
              setColumnOrder={handleColumnOrderChange}
              rowHeight={rowHeight}
              setRowHeight={setRowHeight}
              filterState={filterState}
              orderByState={orderBy}
              currentSearchQuery={searchQuery ?? ""}
              viewConfig={{
                tableName: TableViewPresetTableName.Evaluators,
                projectId,
                controllers: viewControllers,
              }}
            />
            <ResizableFilterLayout>
              <DataTableControls
                key={`${viewControllers.filterEditorResetKey}:${queryFilter.draftResetKey}`}
                queryFilter={queryFilter}
              />
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <DataTable
                  tableName="evaluators-v2-overview-v2"
                  columns={columns}
                  data={
                    evaluators.isPending || isViewLoading
                      ? { isLoading: true, isError: false }
                      : evaluators.isError
                        ? {
                            isLoading: false,
                            isError: true,
                            error: evaluators.error.message,
                          }
                        : {
                            isLoading: false,
                            isError: false,
                            data: evaluators.data.evaluators,
                          }
                  }
                  pagination={{
                    totalCount: evaluators.data?.totalItems ?? null,
                    state: {
                      pageIndex: pagination.page - 1,
                      pageSize: pagination.limit,
                    },
                    onChange: (updater) => {
                      const next =
                        typeof updater === "function"
                          ? updater({
                              pageIndex: pagination.page - 1,
                              pageSize: pagination.limit,
                            })
                          : updater;
                      setPagination({
                        page: next.pageIndex + 1,
                        limit: next.pageSize,
                      });
                    },
                  }}
                  selectionStore={selectionStore}
                  columnVisibility={columnVisibility}
                  onColumnVisibilityChange={handleColumnVisibilityChange}
                  columnOrder={columnOrder}
                  onColumnOrderChange={handleColumnOrderChange}
                  rowHeight={rowHeight}
                  orderBy={orderBy}
                  setOrderBy={handleOrderByChange}
                  onRowClick={(row) =>
                    router.push(`/project/${projectId}/evals/${row.id}`)
                  }
                  noResultsMessage={t("No evaluators found.")}
                />
              </div>
            </ResizableFilterLayout>
          </div>
        </DataTableControlsProvider>
      )}

      <EvaluatorsOverviewSelectionBar
        selectionStore={selectionStore}
        totalCount={evaluators.data?.totalItems ?? null}
        canDelete={hasEvaluatorWriteAccess}
        onDeleteSelection={({ selectAll, selectedIds }) => {
          if (selectAll) setDeleteAll(true);
          else setDeleteIds(selectedIds);
        }}
      />
      <EvaluatorBulkDeleteDialog
        open={deleteAll || deleteIds.length > 0}
        scope={deleteAll ? "allMatching" : "selected"}
        isDeleting={deleteMany.isPending}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteIds([]);
            setDeleteAll(false);
          }
        }}
        onConfirm={() =>
          deleteMany.mutate(
            deleteAll
              ? {
                  projectId,
                  isBatchAction: true,
                  search: searchQuery ?? undefined,
                  filter: filterState,
                }
              : { projectId, evaluatorIds: deleteIds },
          )
        }
      />
      <EvaluatorGalleryDialog
        projectId={projectId}
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        onSelectTemplate={(template) => {
          router.push(evaluatorCreateHref(projectId, template));
        }}
        onCreateFromScratch={(type) => {
          router.push(
            `/project/${projectId}/evals/new?type=${encodeURIComponent(type)}`,
          );
        }}
      />
      {projectDefaultModel.defaultModel &&
      projectDefaultModel.update.pendingModel ? (
        <DefaultModelChangeConfirmationDialog
          open
          currentModel={projectDefaultModel.defaultModel}
          nextModel={projectDefaultModel.update.pendingModel}
          loading={projectDefaultModel.update.isPending}
          onOpenChange={(open) => {
            if (!open) projectDefaultModel.update.dismissConfirmation();
          }}
          onConfirm={projectDefaultModel.update.confirmUpdate}
        />
      ) : null}
      {defaultModelConfig ? (
        <JudgeModelConfigurationDialog
          open={defaultModelConfigurationOpen}
          projectId={projectId}
          initialModel={defaultModelConfig}
          onOpenChange={setDefaultModelConfigurationOpen}
          onSave={projectDefaultModel.update.updateConfiguration}
        />
      ) : null}
    </Page>
  );
}
