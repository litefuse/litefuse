import { render, screen } from "@testing-library/react";
import { useHasEntitlement } from "../entitlements/hooks";
import { useHasProjectAccess } from "../rbac/utils/checkProjectAccess";
import { AuditLogsSettingsPage } from "./AuditLogsSettingsPage";

jest.mock("../entitlements/hooks");
jest.mock("../rbac/utils/checkProjectAccess");
jest.mock("../../components/layouts/header", () => ({
  __esModule: true,
  default: () => <div data-testid="page-header" />,
}));
jest.mock("./AuditLogsTable", () => ({
  AuditLogsTable: (props: Record<string, unknown>) => (
    <div
      data-testid="audit-logs-table"
      data-scope={String(props.scope)}
      data-project-id={String(props.projectId ?? "")}
    />
  ),
}));

const mockedUseHasEntitlement = useHasEntitlement as jest.Mock;
const mockedUseHasProjectAccess = useHasProjectAccess as jest.Mock;

/**
 * Functional characterisation test for the project audit-log settings page.
 *
 * User-visible wording is deliberately NOT pinned: the product owner allows
 * copy and presentation to change, so the test asserts only what the page must
 * *do* — which of the three states it lands in, and the props the table gets.
 */
describe("AuditLogsSettingsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("withholds the table when the project is not entitled", () => {
    mockedUseHasEntitlement.mockReturnValue(false);
    mockedUseHasProjectAccess.mockReturnValue(true);

    render(<AuditLogsSettingsPage projectId="p1" />);

    expect(screen.queryByTestId("audit-logs-table")).toBeNull();
  });

  it("withholds the table when entitled but the scope is missing", () => {
    mockedUseHasEntitlement.mockReturnValue(true);
    mockedUseHasProjectAccess.mockReturnValue(false);

    render(<AuditLogsSettingsPage projectId="p1" />);

    expect(screen.queryByTestId("audit-logs-table")).toBeNull();
  });

  it("tells the two restriction reasons apart", () => {
    mockedUseHasProjectAccess.mockReturnValue(true);
    mockedUseHasEntitlement.mockReturnValue(false);
    const notEntitled = render(<AuditLogsSettingsPage projectId="p1" />);
    const notEntitledText = notEntitled.container.textContent ?? "";
    notEntitled.unmount();

    mockedUseHasEntitlement.mockReturnValue(true);
    mockedUseHasProjectAccess.mockReturnValue(false);
    const notPermitted = render(<AuditLogsSettingsPage projectId="p1" />);
    const notPermittedText = notPermitted.container.textContent ?? "";
    notPermitted.unmount();

    expect(notEntitledText.trim().length).toBeGreaterThan(0);
    expect(notPermittedText.trim().length).toBeGreaterThan(0);
    expect(notEntitledText).not.toBe(notPermittedText);
  });

  it("always renders the page header, restriction or not", () => {
    mockedUseHasEntitlement.mockReturnValue(false);
    mockedUseHasProjectAccess.mockReturnValue(false);

    render(<AuditLogsSettingsPage projectId="p1" />);

    expect(screen.getByTestId("page-header")).toBeTruthy();
  });

  it("renders the project-scoped table when entitled and permitted", () => {
    mockedUseHasEntitlement.mockReturnValue(true);
    mockedUseHasProjectAccess.mockReturnValue(true);

    render(<AuditLogsSettingsPage projectId="p1" />);

    const table = screen.getByTestId("audit-logs-table");
    expect(table.getAttribute("data-scope")).toBe("project");
    expect(table.getAttribute("data-project-id")).toBe("p1");
  });
});
