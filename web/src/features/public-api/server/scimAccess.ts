import { hasEntitlementBasedOnPlan } from "@/src/features/entitlements/server/hasEntitlement";
import { scimErrorBody } from "@/src/features/public-api/server/scimUser";
import { type Plan } from "@langfuse/shared";
import { logger } from "@langfuse/shared/src/server";
import { type NextApiResponse } from "next";

/**
 * Plan gate shared by the SCIM endpoints.
 *
 * SCIM belongs to the organization administration surface: an organization key
 * can create accounts and hand out organization roles, which is the same
 * capability the sibling organization admin endpoints (memberships, projects,
 * API keys) expose. So it is offered on exactly the plans that carry the
 * `admin-api` entitlement - without the gate, a key on a plan that does not
 * include the feature could still provision users and escalate roles.
 *
 * Only the handlers that read or write User resources are gated; the three
 * discovery endpoints stay reachable so a client can still tell why it is being
 * refused instead of failing with a generic error.
 */
export const SCIM_REQUIRED_ENTITLEMENT = "admin-api";

/** Wording shared with the other organization admin endpoints. */
export const SCIM_PLAN_REQUIRED_DETAIL =
  "This feature is not available on your current plan.";

export function scimAllowedForPlan(plan: Plan | null): boolean {
  return hasEntitlementBasedOnPlan({
    plan,
    entitlement: SCIM_REQUIRED_ENTITLEMENT,
  });
}

/**
 * Refuse the request when the organization behind the API key is on a plan
 * without the SCIM entitlement.
 *
 * Returns `true` when the request was refused and the caller must stop - note it
 * cannot return the response itself: `NextApiResponse.json()` returns `void`, so
 * a "response or null" helper would be `undefined` and the handler would happily
 * keep running after sending the 403 (and write the user anyway).
 */
export function rejectUnlessScimIsEntitled({
  res,
  plan,
  route,
}: {
  res: NextApiResponse;
  plan: Plan | null;
  route: string;
}): boolean {
  if (scimAllowedForPlan(plan)) return false;

  logger.warn(
    `SCIM request to ${route} refused: plan ${plan ?? "unknown"} does not include the ${SCIM_REQUIRED_ENTITLEMENT} entitlement`,
  );
  res.status(403).json(scimErrorBody(403, SCIM_PLAN_REQUIRED_DETAIL));
  return true;
}
