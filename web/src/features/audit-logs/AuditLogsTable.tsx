import { DataTable } from "@/src/components/table/data-table";
import { type LangfuseColumnDef } from "@/src/components/table/types";
import { api, type RouterOutputs } from "@/src/utils/api";
import { safeExtract } from "@/src/utils/map-utils";
import { useQueryParams, withDefault, NumberParam } from "use-query-params";
import { IOTableCell } from "@/src/components/ui/IOTableCell";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/src/components/ui/avatar";
import { cn } from "@/src/utils/tailwind";
import {
  useRowHeightLocalStorage,
  type RowHeight,
} from "@/src/components/table/data-table-row-height-switch";
import { DataTableToolbar } from "@/src/components/table/data-table-toolbar";
import { SettingsTableCard } from "@/src/components/layouts/settings-table-card";
import { BatchExportTableButton } from "@/src/components/BatchExportTableButton";
import { BatchExportTableName } from "@langfuse/shared";
import type { TFunction } from "i18next";

import { useTranslation } from "react-i18next";
// Both endpoints return the same shape
type AuditLogRow = RouterOutputs["auditLogs"]["all"]["data"][number];

// A caller renders exactly one audit-log source: a single project, or the
// organization that project belongs to.
type ProjectScopeProps = { projectId: string; scope: "project" };
type OrganizationScopeProps = { orgId: string; scope: "organization" };
type AuditLogsTableProps = ProjectScopeProps | OrganizationScopeProps;

// Column sizing and row height are persisted per table name, so the two scopes
// are kept apart by using a distinct id for each of them.
const TABLE_ID_BY_SCOPE = {
  project: "auditLogs",
  organization: "orgAuditLogs",
} as const;

/**
 * Builds the audit-log columns. Kept outside the component so the table body
 * and the toolbar share one definition without depending on component state.
 */
function buildAuditLogColumns(options: {
  t: TFunction;
  rowHeight: RowHeight;
}): LangfuseColumnDef<AuditLogRow>[] {
  const { t, rowHeight } = options;
  const singleLineJson = rowHeight === "s";

  const jsonCell = (value: string | null) =>
    value ? <IOTableCell data={value} singleLine={singleLineJson} /> : null;

  return [
    {
      accessorKey: "createdAt",
      header: t("Time"),
      cell: (row) => (row.getValue() as Date).toLocaleString(),
    },
    {
      accessorKey: "actor",
      header: t("Actor"),
      headerTooltip: {
        description: t("The actor within Litefuse who performed the action."),
      },
      cell: (row) => {
        const actor = row.getValue() as AuditLogRow["actor"];

        if (actor?.type === "USER") {
          const user = actor.body;
          return (
            <div className="flex items-center gap-2">
              <Avatar className="h-6 w-6">
                {user?.image && (
                  <AvatarImage src={user.image} alt={user?.name ?? t("User")} />
                )}
                <AvatarFallback>
                  {user?.name?.charAt(0) ?? user?.email?.charAt(0) ?? "U"}
                </AvatarFallback>
              </Avatar>
              <span
                className={cn(
                  "text-sm",
                  !user?.name && "text-muted-foreground",
                )}
              >
                {user?.name ?? user?.email ?? user?.id}
              </span>
            </div>
          );
        }

        if (actor?.type === "API_KEY") {
          const apiKey = actor.body;
          return (
            <div className="flex items-center gap-2">
              <span className="text-sm">{apiKey?.publicKey ?? apiKey?.id}</span>
            </div>
          );
        }

        return null;
      },
    },
    {
      accessorKey: "resourceType",
      header: t("Resource Type"),
    },
    {
      accessorKey: "resourceId",
      header: t("Resource ID"),
    },
    {
      accessorKey: "action",
      header: t("Action"),
    },
    {
      accessorKey: "before",
      header: t("Before"),
      size: 300,
      cell: (row) => jsonCell(row.getValue() as string | null),
    },
    {
      accessorKey: "after",
      header: t("After"),
      size: 300,
      cell: (row) => jsonCell(row.getValue() as string | null),
    },
  ];
}

export function AuditLogsTable(props: AuditLogsTableProps) {
  const { t } = useTranslation();
  const [paginationState, setPaginationState] = useQueryParams({
    pageIndex: withDefault(NumberParam, 0),
    pageSize: withDefault(NumberParam, 50),
  });

  const isOrganizationScope = props.scope === "organization";
  // The query that is not in use still needs a value for the foreign id it
  // expects, hence the empty string.
  const projectId = props.scope === "project" ? props.projectId : "";
  const orgId = props.scope === "organization" ? props.orgId : "";
  const page = paginationState.pageIndex;
  const limit = paginationState.pageSize;

  // Both hooks run on every render so that hook order stays stable; only the
  // query matching the active scope is enabled and reaches the server.
  const projectRows = api.auditLogs.all.useQuery(
    { projectId, page, limit },
    { enabled: !isOrganizationScope },
  );

  const orgRows = api.auditLogs.allByOrg.useQuery(
    { orgId, page, limit },
    { enabled: isOrganizationScope },
  );

  const rows = isOrganizationScope ? orgRows : projectRows;
  const tableId = isOrganizationScope
    ? TABLE_ID_BY_SCOPE.organization
    : TABLE_ID_BY_SCOPE.project;
  const [density, setDensity] = useRowHeightLocalStorage(tableId, "s");

  const columns = buildAuditLogColumns({ t, rowHeight: density });

  return (
    <>
      <DataTableToolbar
        columns={columns}
        rowHeight={density}
        setRowHeight={setDensity}
        actionButtons={
          props.scope === "project"
            ? [
                <BatchExportTableButton
                  key="audit-logs-export"
                  projectId={props.projectId}
                  tableName={BatchExportTableName.AuditLogs}
                  filterState={[]}
                  orderByState={{ column: "createdAt", order: "DESC" }}
                />,
              ]
            : []
        }
        className="px-0"
      />
      <SettingsTableCard>
        <DataTable
          tableName={tableId}
          columns={columns}
          data={
            rows.isPending
              ? { isLoading: true, isError: false }
              : rows.isError
                ? {
                    isLoading: false,
                    isError: true,
                    error: rows.error.message,
                  }
                : {
                    isLoading: false,
                    isError: false,
                    data: safeExtract(rows.data, "data", []),
                  }
          }
          pagination={{
            totalCount: rows.data?.totalCount ?? 0,
            onChange: setPaginationState,
            state: paginationState,
          }}
          rowHeight={density}
        />
      </SettingsTableCard>
    </>
  );
}
