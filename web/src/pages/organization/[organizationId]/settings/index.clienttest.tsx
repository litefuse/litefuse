import { renderHook } from "@testing-library/react";
import { useHasEntitlement } from "../../../../features/entitlements/hooks";
import { useQueryProjectOrOrganization } from "../../../../features/projects/hooks";
import { useHasOrganizationAccess } from "../../../../features/rbac/utils/checkOrganizationAccess";
import { useOrganizationSettingsPages } from "./index";

jest.mock("../../../../env.mjs", () => ({
  env: { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION: undefined },
}));
jest.mock("../../../../features/entitlements/hooks");
jest.mock("../../../../features/projects/hooks");
jest.mock("../../../../features/rbac/utils/checkOrganizationAccess");

const mockedUseHasEntitlement = useHasEntitlement as jest.Mock;
const mockedUseQueryProjectOrOrganization =
  useQueryProjectOrOrganization as jest.Mock;
const mockedUseHasOrganizationAccess = useHasOrganizationAccess as jest.Mock;

describe("useOrganizationSettingsPages", () => {
  beforeEach(() => {
    mockedUseHasEntitlement.mockReturnValue(false);
    mockedUseQueryProjectOrOrganization.mockReturnValue({
      organization: {
        id: "org_test",
        name: "Test Organization",
        metadata: {},
      },
    });
  });

  afterEach(() => jest.resetAllMocks());

  it("shows Billing without a configured cloud region when the user has access", () => {
    mockedUseHasOrganizationAccess.mockReturnValue(true);

    const { result } = renderHook(() => useOrganizationSettingsPages());

    expect(result.current.find((page) => page.slug === "billing")?.show).toBe(
      true,
    );
  });

  it("hides Billing when the user does not have access", () => {
    mockedUseHasOrganizationAccess.mockReturnValue(false);

    const { result } = renderHook(() => useOrganizationSettingsPages());

    expect(result.current.find((page) => page.slug === "billing")?.show).toBe(
      false,
    );
  });
});
