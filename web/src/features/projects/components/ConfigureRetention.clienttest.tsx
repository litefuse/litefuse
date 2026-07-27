import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useHasEntitlement } from "../../entitlements/hooks";
import { usePostHogClientCapture } from "../../posthog-analytics/usePostHogClientCapture";
import { useHasProjectAccess } from "../../rbac/utils/checkProjectAccess";
import { api } from "../../../utils/api";
import { useQueryProject } from "../hooks";
import ConfigureRetention from "./ConfigureRetention";

jest.mock("../hooks");
jest.mock("../../entitlements/hooks");
jest.mock("../../posthog-analytics/usePostHogClientCapture");
jest.mock("../../rbac/utils/checkProjectAccess");
jest.mock("next-auth/react", () => ({
  useSession: () => ({ update: jest.fn() }),
}));
jest.mock("../../../utils/api", () => ({
  api: {
    projects: {
      setRetention: {
        useMutation: jest.fn(() => ({
          mutateAsync: jest.fn(),
          isPending: false,
        })),
      },
    },
  },
}));

const mockedUseQueryProject = useQueryProject as jest.Mock;
const mockedUseHasProjectAccess = useHasProjectAccess as jest.Mock;
const mockedUseHasEntitlement = useHasEntitlement as jest.Mock;
const mockedCapture = usePostHogClientCapture as jest.Mock;
const mockedSetRetention = api.projects.setRetention.useMutation as jest.Mock;

describe("ConfigureRetention", () => {
  let mutateAsync: jest.Mock;

  beforeEach(() => {
    mutateAsync = jest.fn().mockResolvedValue(undefined);
    mockedUseHasProjectAccess.mockReturnValue(true);
    mockedUseHasEntitlement.mockReturnValue(true);
    mockedCapture.mockReturnValue(jest.fn());
    mockedSetRetention.mockReturnValue({
      mutateAsync,
      isPending: false,
    });
  });

  afterEach(() => jest.resetAllMocks());

  it("refreshes retention days when switching projects", () => {
    let project = {
      id: "project_a",
      retentionDays: 7,
    };
    mockedUseQueryProject.mockImplementation(() => ({
      project,
      organization: null,
    }));

    const { rerender } = render(<ConfigureRetention />);

    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe(
      "7",
    );

    project = {
      id: "project_b",
      retentionDays: 30,
    };
    rerender(<ConfigureRetention />);

    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe(
      "30",
    );
  });

  it("keeps the saved retention days in the form", async () => {
    mockedUseQueryProject.mockReturnValue({
      project: {
        id: "project_a",
        retentionDays: 7,
      },
      organization: null,
    });
    render(<ConfigureRetention />);

    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        projectId: "project_a",
        retention: 30,
      }),
    );
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe(
      "30",
    );
  });
});
