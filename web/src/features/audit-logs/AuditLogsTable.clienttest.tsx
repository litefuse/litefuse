import { render } from "@testing-library/react";
import { api } from "../../utils/api";
import { DataTable } from "../../components/table/data-table";
import { DataTableToolbar } from "../../components/table/data-table-toolbar";
import { AuditLogsTable } from "./AuditLogsTable";

jest.mock("../../utils/api", () => ({
  api: {
    auditLogs: {
      all: { useQuery: jest.fn() },
      allByOrg: { useQuery: jest.fn() },
    },
  },
}));
jest.mock("use-query-params", () => ({
  useQueryParams: () => [{ pageIndex: 0, pageSize: 50 }, jest.fn()],
  withDefault: (_param: unknown, fallback: unknown) => fallback,
  NumberParam: {},
}));
jest.mock("../../components/table/data-table-row-height-switch", () => ({
  useRowHeightLocalStorage: () => ["s", jest.fn()],
}));
jest.mock("../../components/table/data-table", () => ({
  DataTable: jest.fn(() => null),
}));
jest.mock("../../components/table/data-table-toolbar", () => ({
  DataTableToolbar: jest.fn(() => null),
}));
jest.mock("../../components/layouts/settings-table-card", () => ({
  SettingsTableCard: ({ children }: { children?: unknown }) => <>{children}</>,
}));
jest.mock("../../components/BatchExportTableButton", () => ({
  BatchExportTableButton: () => <div data-testid="audit-logs-export" />,
}));

const mockedProjectQuery = api.auditLogs.all.useQuery as unknown as jest.Mock;
const mockedOrgQuery = api.auditLogs.allByOrg.useQuery as unknown as jest.Mock;
const mockedDataTable = DataTable as unknown as jest.Mock;
const mockedToolbar = DataTableToolbar as unknown as jest.Mock;

const row = {
  id: "log-1",
  createdAt: new Date("2026-01-02T03:04:05Z"),
  actor: null,
  resourceType: "project",
  resourceId: "p1",
  action: "update",
  before: null,
  after: null,
};

const loaded = (rows: unknown[] = [row], totalCount = 1) => ({
  isPending: false,
  isError: false,
  data: { data: rows, totalCount },
});

/**
 * Characterisation test for the audit-log table. It pins the contract the rest
 * of the app depends on: which query is enabled per scope, how the query state
 * maps onto the table's props, the column set, the persisted table id per scope
 * and the scope-specific export action. Markup and class names stay free.
 */
describe("AuditLogsTable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedProjectQuery.mockReturnValue(loaded());
    mockedOrgQuery.mockReturnValue(loaded());
  });

  it("enables only the project query and passes the project id in project scope", () => {
    render(<AuditLogsTable scope="project" projectId="p1" />);

    expect(mockedProjectQuery).toHaveBeenCalledWith(
      { projectId: "p1", page: 0, limit: 50 },
      { enabled: true },
    );
    expect(mockedOrgQuery).toHaveBeenCalledWith(
      { orgId: "", page: 0, limit: 50 },
      { enabled: false },
    );
  });

  it("enables only the organisation query in organisation scope", () => {
    render(<AuditLogsTable scope="organization" orgId="o1" />);

    expect(mockedProjectQuery).toHaveBeenCalledWith(
      { projectId: "", page: 0, limit: 50 },
      { enabled: false },
    );
    expect(mockedOrgQuery).toHaveBeenCalledWith(
      { orgId: "o1", page: 0, limit: 50 },
      { enabled: true },
    );
  });

  it("maps the pending query state onto the table", () => {
    mockedProjectQuery.mockReturnValue({ isPending: true });

    render(<AuditLogsTable scope="project" projectId="p1" />);

    expect(mockedDataTable.mock.calls[0]![0].data).toEqual({
      isLoading: true,
      isError: false,
    });
  });

  it("maps the failed query state and forwards the message", () => {
    mockedProjectQuery.mockReturnValue({
      isPending: false,
      isError: true,
      error: { message: "audit log query failed" },
    });

    render(<AuditLogsTable scope="project" projectId="p1" />);

    expect(mockedDataTable.mock.calls[0]![0].data).toEqual({
      isLoading: false,
      isError: true,
      error: "audit log query failed",
    });
  });

  it("passes the rows and the total count through", () => {
    mockedProjectQuery.mockReturnValue(loaded([row, row], 7));

    render(<AuditLogsTable scope="project" projectId="p1" />);

    const props = mockedDataTable.mock.calls[0]![0];
    expect(props.data.data).toHaveLength(2);
    expect(props.pagination.totalCount).toBe(7);
  });

  it("defines the audit log columns in order", () => {
    render(<AuditLogsTable scope="project" projectId="p1" />);

    const columns = mockedDataTable.mock.calls[0]![0].columns as {
      accessorKey: string;
    }[];
    expect(columns.map((column) => column.accessorKey)).toEqual([
      "createdAt",
      "actor",
      "resourceType",
      "resourceId",
      "action",
      "before",
      "after",
    ]);
  });

  it("keys the persisted table state per scope", () => {
    const { unmount } = render(
      <AuditLogsTable scope="project" projectId="p1" />,
    );
    expect(mockedDataTable.mock.calls[0]![0].tableName).toBe("auditLogs");
    unmount();

    mockedDataTable.mockClear();
    render(<AuditLogsTable scope="organization" orgId="o1" />);
    expect(mockedDataTable.mock.calls[0]![0].tableName).toBe("orgAuditLogs");
  });

  it("offers the export action for projects only", () => {
    const { unmount } = render(
      <AuditLogsTable scope="project" projectId="p1" />,
    );
    const projectButtons = mockedToolbar.mock.calls[0]![0].actionButtons as {
      props: Record<string, unknown>;
    }[];
    expect(projectButtons).toHaveLength(1);
    expect(projectButtons[0]!.props.projectId).toBe("p1");
    unmount();

    mockedToolbar.mockClear();
    render(<AuditLogsTable scope="organization" orgId="o1" />);
    expect(mockedToolbar.mock.calls[0]![0].actionButtons).toHaveLength(0);
  });
});
