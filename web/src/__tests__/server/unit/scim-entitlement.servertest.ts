import {
  SCIM_PLAN_REQUIRED_DETAIL,
  SCIM_REQUIRED_ENTITLEMENT,
  scimAllowedForPlan,
} from "@/src/features/public-api/server/scimAccess";
import { type Plan } from "@langfuse/shared";

/**
 * SCIM is part of the organization administration surface, so it is available
 * exactly on the plans that carry the `admin-api` entitlement - the same one the
 * sibling organization admin REST endpoints (memberships, projects, apiKeys)
 * require. These cases pin that mapping down: a plan change must never silently
 * enable or disable account provisioning.
 *
 * Pure mapping checks, no HTTP: the request-level behaviour is covered by
 * `scim-api.servertest.ts` against a running web server.
 */
describe("SCIM plan entitlement", () => {
  it("requires the admin-api entitlement", () => {
    expect(SCIM_REQUIRED_ENTITLEMENT).toBe("admin-api");
  });

  it.each<Plan>(["oss", "cloud:developer"])(
    "is unavailable on the %s plan",
    (plan) => {
      expect(scimAllowedForPlan(plan)).toBe(false);
    },
  );

  it.each<Plan>(["self-hosted:enterprise", "cloud:pro"])(
    "is available on the %s plan",
    (plan) => {
      expect(scimAllowedForPlan(plan)).toBe(true);
    },
  );

  it("is unavailable when the organization has no plan at all", () => {
    expect(scimAllowedForPlan(null)).toBe(false);
  });

  it("answers a blocked request with the plan message the admin API uses", () => {
    expect(SCIM_PLAN_REQUIRED_DETAIL).toBe(
      "This feature is not available on your current plan.",
    );
  });
});
