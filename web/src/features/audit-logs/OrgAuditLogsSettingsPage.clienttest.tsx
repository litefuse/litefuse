import { render, screen } from "@testing-library/react";
import { useHasEntitlement } from "../entitlements/hooks";
import { useHasOrganizationAccess } from "../rbac/utils/checkOrganizationAccess";
import { OrgAuditLogsSettingsPage } from "./OrgAuditLogsSettingsPage";

jest.mock("../entitlements/hooks");
jest.mock("../rbac/utils/checkOrganizationAccess");
jest.mock("../../components/layouts/header", () => ({
  __esModule: true,
  default: () => <div data-testid="page-header" />,
}));
jest.mock("./AuditLogsTable", () => ({
  AuditLogsTable: (props: Record<string, unknown>) => (
    <div
      data-testid="audit-logs-table"
      data-scope={String(props.scope)}
      data-org-id={String(props.orgId ?? "")}
    />
  ),
}));

const mockedUseHasEntitlement = useHasEntitlement as jest.Mock;
const mockedUseHasOrganizationAccess = useHasOrganizationAccess as jest.Mock;

/**
 * Functional characterisation test for the organisation audit-log settings
 * page: the same three states as the project page, asserting behaviour only —
 * wording and presentation are free to change.
 */
describe("OrgAuditLogsSettingsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("withholds the table when the organisation is not entitled", () => {
    mockedUseHasEntitlement.mockReturnValue(false);
    mockedUseHasOrganizationAccess.mockReturnValue(true);

    render(<OrgAuditLogsSettingsPage orgId="o1" />);

    expect(screen.queryByTestId("audit-logs-table")).toBeNull();
  });

  it("withholds the table when entitled but the scope is missing", () => {
    mockedUseHasEntitlement.mockReturnValue(true);
    mockedUseHasOrganizationAccess.mockReturnValue(false);

    render(<OrgAuditLogsSettingsPage orgId="o1" />);

    expect(screen.queryByTestId("audit-logs-table")).toBeNull();
  });

  it("tells the two restriction reasons apart", () => {
    mockedUseHasOrganizationAccess.mockReturnValue(true);
    mockedUseHasEntitlement.mockReturnValue(false);
    const notEntitled = render(<OrgAuditLogsSettingsPage orgId="o1" />);
    const notEntitledText = notEntitled.container.textContent ?? "";
    notEntitled.unmount();

    mockedUseHasEntitlement.mockReturnValue(true);
    mockedUseHasOrganizationAccess.mockReturnValue(false);
    const notPermitted = render(<OrgAuditLogsSettingsPage orgId="o1" />);
    const notPermittedText = notPermitted.container.textContent ?? "";
    notPermitted.unmount();

    expect(notEntitledText.trim().length).toBeGreaterThan(0);
    expect(notPermittedText.trim().length).toBeGreaterThan(0);
    expect(notEntitledText).not.toBe(notPermittedText);
  });

  it("always renders the page header, restriction or not", () => {
    mockedUseHasEntitlement.mockReturnValue(false);
    mockedUseHasOrganizationAccess.mockReturnValue(false);

    render(<OrgAuditLogsSettingsPage orgId="o1" />);

    expect(screen.getByTestId("page-header")).toBeTruthy();
  });

  it("renders the organisation-scoped table when entitled and permitted", () => {
    mockedUseHasEntitlement.mockReturnValue(true);
    mockedUseHasOrganizationAccess.mockReturnValue(true);

    render(<OrgAuditLogsSettingsPage orgId="o1" />);

    const table = screen.getByTestId("audit-logs-table");
    expect(table.getAttribute("data-scope")).toBe("organization");
    expect(table.getAttribute("data-org-id")).toBe("o1");
  });
});
