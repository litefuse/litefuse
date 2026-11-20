import { act, render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { createI18nInstance } from "@/src/features/i18n/instance";
import { DashboardTable } from "./DashboardTable";

const mockManagedDashboard = {
  id: "managed-dashboard",
  name: "Litefuse Cost Dashboard",
  description: "Review your LLM costs.",
  owner: "LANGFUSE",
};
const mockProjectDashboard = {
  ...mockManagedDashboard,
  id: "project-dashboard",
  owner: "PROJECT",
};
const mockSetDetailPageList = jest.fn();

jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("../../../hooks/useProjectIdFromURL", () => ({
  __esModule: true,
  default: () => "project-1",
}));
jest.mock("../../orderBy/hooks/useOrderByState", () => ({
  useOrderByState: () => [{ column: "updatedAt", order: "DESC" }, jest.fn()],
}));
jest.mock("use-query-params", () => ({
  ...jest.requireActual("use-query-params"),
  useQueryParams: () => [{ pageIndex: 0, pageSize: 50 }, jest.fn()],
}));
jest.mock("../../navigate-detail-pages/context", () => ({
  useDetailPageLists: () => ({ setDetailPageList: mockSetDetailPageList }),
}));
jest.mock("../../rbac/utils/checkProjectAccess", () => ({
  useHasProjectAccess: () => true,
}));
jest.mock("../../posthog-analytics/usePostHogClientCapture", () => ({
  usePostHogClientCapture: () => jest.fn(),
}));
jest.mock("../../../components/deleteButton", () => ({
  DeleteDashboardButton: () => null,
}));
jest.mock("../../../utils/api", () => ({
  api: {
    dashboard: {
      allDashboards: {
        useQuery: () => ({
          isSuccess: true,
          data: {
            dashboards: [mockManagedDashboard, mockProjectDashboard],
            totalCount: 2,
          },
        }),
      },
    },
  },
}));

// Render the real table's name/description cells without its pagination and
// virtualization dependencies. The query rows stay unchanged for row actions.
jest.mock("../../../components/table/data-table", () => ({
  DataTable: ({
    columns,
    data,
  }: {
    columns: {
      id: string;
      cell: (context: {
        getValue: () => string;
        row: { original: typeof mockManagedDashboard };
      }) => ReactNode;
    }[];
    data: { data: (typeof mockManagedDashboard)[] };
  }) => (
    <div>
      {data.data.map((item) => (
        <div key={item.id}>
          {columns
            .filter(
              (column) => column.id === "name" || column.id === "description",
            )
            .map((column) => (
              <div key={column.id}>
                {column.cell({
                  getValue: () => item[column.id as "name" | "description"],
                  row: { original: item },
                })}
              </div>
            ))}
        </div>
      ))}
    </div>
  ),
}));

describe("managed dashboards in the dashboard list", () => {
  it("localizes managed rows and preserves project rows with the same text", async () => {
    const i18n = createI18nInstance("zh-CN");
    render(
      <I18nextProvider i18n={i18n}>
        <DashboardTable />
      </I18nextProvider>,
    );

    expect(
      screen.getByRole("link", { name: "Litefuse 成本仪表盘" }),
    ).toBeTruthy();
    expect(screen.getByText("查看 LLM 成本。")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: mockProjectDashboard.name }),
    ).toBeTruthy();
    expect(screen.getByText(mockProjectDashboard.description)).toBeTruthy();

    await act(async () => {
      await i18n.changeLanguage("en");
    });

    expect(screen.queryByText("Litefuse 成本仪表盘")).toBeNull();
    expect(screen.getAllByText(mockManagedDashboard.name)).toHaveLength(2);
    expect(screen.getAllByText(mockManagedDashboard.description)).toHaveLength(
      2,
    );
  });
});
