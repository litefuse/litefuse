import { i18nKey } from "@/src/features/i18n/i18nKey";
import { DataTable } from "@/src/components/table/data-table";
import { type LangfuseColumnDef } from "@/src/components/table/types";
import { api } from "@/src/utils/api";
import { safeExtract } from "@/src/utils/map-utils";
import { StatusBadge } from "@/src/components/layouts/status-badge";
import { NumberParam, useQueryParams, withDefault } from "use-query-params";
import { InfoIcon } from "lucide-react";
import { Avatar, AvatarImage } from "@/src/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/src/components/ui/tooltip";
import { LocalIsoDate } from "@/src/components/LocalIsoDate";

import { useTranslation } from "react-i18next";
type BatchActionRow = {
  id: string;
  actionType: string;
  tableName: string;
  status: string;
  totalCount: number | null;
  processedCount: number | null;
  failedCount: number | null;
  createdAt: Date;
  finishedAt: Date | null;
  log: string | null;
  user: {
    name: string | null;
    image: string | null;
  } | null;
};

/**
 * `ActionId` and `BatchTableNames` are API enums, so the row stores them
 * verbatim and the label is looked up here.
 */
const ACTION_ID_LABELS: Record<string, string> = {
  "score-delete": i18nKey("Delete scores"),
  "trace-delete": i18nKey("Delete traces"),
  "trace-add-to-annotation-queue": i18nKey("Add traces to annotation queue"),
  "session-add-to-annotation-queue": i18nKey(
    "Add sessions to annotation queue",
  ),
  "observation-add-to-annotation-queue": i18nKey(
    "Add observations to annotation queue",
  ),
  "observation-add-to-dataset": i18nKey("Add observations to dataset"),
  "observation-run-batched-evaluation": i18nKey(
    "Run evaluation on observations",
  ),
};

const BATCH_TABLE_LABELS: Record<string, string> = {
  scores: i18nKey("Scores"),
  sessions: i18nKey("Sessions"),
  traces: i18nKey("Traces"),
  observations: i18nKey("Observations"),
  events: i18nKey("Events"),
  dataset_run_items: i18nKey("Dataset run items"),
  dataset_items: i18nKey("Dataset items"),
  audit_logs: i18nKey("Audit logs"),
};

export function BatchActionsTable(props: { projectId: string }) {
  const { t } = useTranslation();
  const [paginationState, setPaginationState] = useQueryParams({
    pageIndex: withDefault(NumberParam, 0),
    pageSize: withDefault(NumberParam, 10),
  });

  const batchActions = api.batchAction.all.useQuery({
    projectId: props.projectId,
    limit: paginationState.pageSize,
    page: paginationState.pageIndex,
  });

  const columns: LangfuseColumnDef<BatchActionRow>[] = [
    {
      accessorKey: "actionType",
      id: "actionType",
      header: t("Action Type"),
      size: 200,
      cell: ({ row }) => {
        const actionType = row.getValue("actionType") as string;
        return <span>{t(ACTION_ID_LABELS[actionType] ?? actionType)}</span>;
      },
    },
    {
      accessorKey: "tableName",
      id: "tableName",
      header: t("Table"),
      size: 120,
      cell: ({ row }) => {
        const tableName = row.getValue("tableName") as string;
        return <span>{t(BATCH_TABLE_LABELS[tableName] ?? tableName)}</span>;
      },
    },
    {
      accessorKey: "status",
      id: "status",
      header: t("Status"),
      size: 110,
      cell: ({ row }) => {
        const status = row.getValue("status") as string;
        return (
          <StatusBadge type={status.toLowerCase()} className="capitalize" />
        );
      },
    },
    {
      accessorKey: "progress",
      id: "progress",
      header: t("Progress"),
      size: 150,
      cell: ({ row }) => {
        const totalCount = row.original.totalCount;
        const processedCount = row.original.processedCount ?? 0;
        const failedCount = row.original.failedCount ?? 0;

        if (!totalCount)
          return <span className="text-muted-foreground">-</span>;

        return (
          <div className="space-y-1">
            <div className="text-sm">
              {processedCount} / {totalCount}
            </div>
            {failedCount > 0 && (
              <div className="text-destructive text-xs">
                {t("{{count}} failed", { count: failedCount })}
              </div>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "createdAt",
      id: "createdAt",
      header: t("Created"),
      size: 150,
      cell: ({ row }) => {
        const createdAt = row.getValue("createdAt") as Date;
        return <LocalIsoDate date={createdAt} />;
      },
    },
    {
      accessorKey: "finishedAt",
      id: "finishedAt",
      header: t("Finished"),
      size: 150,
      cell: ({ row }) => {
        const finishedAt = row.getValue("finishedAt") as Date | null;
        return finishedAt ? (
          <LocalIsoDate date={finishedAt} />
        ) : (
          <span className="text-muted-foreground">-</span>
        );
      },
    },
    {
      accessorKey: "user",
      id: "user",
      header: t("Created By"),
      size: 150,
      cell: ({ row }) => {
        const user = row.getValue("user") as {
          name: string | null;
          image: string | null;
        } | null;
        return (
          <div className="flex items-center space-x-2">
            <Avatar className="h-7 w-7">
              <AvatarImage
                src={user?.image ?? undefined}
                alt={user?.name ?? t("User Avatar")}
              />
            </Avatar>
            <span>{user?.name ?? t("Unknown")}</span>
          </div>
        );
      },
    },
    {
      accessorKey: "log",
      id: "log",
      header: t("Log"),
      size: 300,
      cell: ({ row }) => {
        const log = row.getValue("log") as string | null;
        return log ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <div className="flex items-center gap-1">
                  <InfoIcon className="text-muted-foreground h-3 w-3" />
                  <span className="max-w-[250px] truncate text-xs">{log}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-md">
                <pre className="max-h-60 overflow-auto text-xs whitespace-pre-wrap">
                  {log}
                </pre>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null;
      },
    },
  ];

  return (
    <DataTable
      tableName={"batchActions"}
      columns={columns}
      data={
        batchActions.isPending
          ? { isLoading: true, isError: false }
          : batchActions.isError
            ? {
                isLoading: false,
                isError: true,
                error: batchActions.error.message,
              }
            : {
                isLoading: false,
                isError: false,
                data: safeExtract(batchActions.data, "batchActions", []),
              }
      }
      pagination={{
        totalCount: batchActions.data?.totalCount ?? 0,
        onChange: setPaginationState,
        state: paginationState,
      }}
    />
  );
}
