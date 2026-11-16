import { prisma } from "@langfuse/shared/src/db";
import { redis, type ApiAccessScope } from "@langfuse/shared/src/server";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { hasEntitlementBasedOnPlan } from "@/src/features/entitlements/server/hasEntitlement";
import { type NextApiRequest, type NextApiResponse } from "next";

/**
 * Auth + entitlement guard for the organization admin API (`admin-api`).
 *
 * Runs three checks in order:
 *   1. Parse and verify the key from Basic Auth → 401 on failure
 *   2. Must be an organization-level key (accessLevel === "organization") → otherwise 403
 *   3. The organization's plan must include the admin-api entitlement → otherwise 403
 *
 * On success it returns the scope (with orgId / plan), which the business
 * functions use to filter resource ownership (prevents cross-organization
 * access). If a check fails the response has already been written and `null` is
 * returned, so the caller can simply return.
 *
 * WHY THIS LIVES IN MIT CODE (LICENSE-EE ANNEX A/B)
 * The admin API's *operations* are licensed material; this guard is the policy
 * that decides whether they may run. Community routes must be able to reject an
 * unavailable operation **without loading licensed code first**, so the guard is
 * deliberately outside ANNEX A: `/api/public/projects` calls it before its
 * dynamic import of the enterprise implementation, which is what makes the
 * "an unlicensed deployment does not load licensed material" claim hold for
 * unauthenticated and unentitled requests too. The enterprise tree keeps its own
 * `requireAdminApi` entry point, which delegates here.
 */
export async function requireAdminApiScope(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<ApiAccessScope | null> {
  const auth = await new ApiAuthService(
    prisma,
    redis,
  ).verifyAuthHeaderAndReturnScope(req.headers.authorization);

  if (!auth.validKey) {
    res.status(401).json({ error: auth.error });
    return null;
  }

  if (auth.scope.accessLevel !== "organization" || !auth.scope.orgId) {
    res.status(403).json({
      error:
        "Invalid API key. Organization-scoped API key required for this operation.",
    });
    return null;
  }

  if (
    !hasEntitlementBasedOnPlan({
      plan: auth.scope.plan,
      entitlement: "admin-api",
    })
  ) {
    res.status(403).json({
      error: "This feature is not available on your current plan.",
    });
    return null;
  }

  return auth.scope;
}
