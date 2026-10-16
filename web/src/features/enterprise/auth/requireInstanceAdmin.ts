import { type NextApiRequest, type NextApiResponse } from "next";
import { AdminApiAuthService } from "@/src/server/adminApiAuth";
import { hasEntitlementBasedOnPlan } from "@/src/features/entitlements/server/hasEntitlement";
import { resolveSelfHostedPlan } from "@/src/features/entitlements/server/resolveSelfHostedPlan";

/**
 * Instance-admin auth middleware (admin endpoints; distinct from the public requireAdminApi).
 *
 * Two checks:
 *   1. Verify the Bearer ADMIN_API_KEY (AdminApiAuthService) → 401/403 on failure
 *   2. Instance-level plan gate (the plan resolved from the self-hosted license must include admin-api) → otherwise 403
 *
 * Returns true on success; on failure the response has already been written and false is returned.
 */
export function requireInstanceAdmin(
  req: NextApiRequest,
  res: NextApiResponse,
): boolean {
  if (!AdminApiAuthService.handleAdminAuth(req, res)) {
    return false;
  }

  const instancePlan = resolveSelfHostedPlan(
    process.env.LITEFUSE_EE_LICENSE_KEY,
  );

  if (
    !hasEntitlementBasedOnPlan({
      plan: instancePlan,
      entitlement: "admin-api",
    })
  ) {
    res.status(403).json({
      error: "This feature is not available on your current plan.",
    });
    return false;
  }

  return true;
}
