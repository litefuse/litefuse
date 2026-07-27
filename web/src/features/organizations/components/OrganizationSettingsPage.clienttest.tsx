import { renderHook } from "@testing-library/react";
import { useHasEntitlement } from "../../entitlements/hooks";
import { useQueryProjectOrOrganization } from "../../projects/hooks";
import { useHasOrganizationAccess } from "../../rbac/utils/checkOrganizationAccess";
import { useOrganizationSettingsPages } from "../../../pages/organization/[organizationId]/settings";

jest.mock("../../../env.mjs", () => ({
  env: { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION: undefined },
}));
jest.mock("../../entitlements/hooks");
jest.mock("../../projects/hooks");
jest.mock("../../rbac/utils/checkOrganizationAccess");

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
