import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import { logger, redis } from "@langfuse/shared/src/server";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { cancelSubscriptionImmediatelyForOrganization } from "@/src/features/billing/server/billingService";

/**
 * Error code shared by both blocking conditions below; the accompanying
 * `message` says which one applies.
 */
const PROJECTS_REMAIN_ERROR =
  "Organization cannot be deleted while it still has projects";

/**
 * Delete an organization (DELETE /api/admin/organizations/{id}, instance admin).
 *
 * Mirrors the UI path (organizationRouter.delete): an organization is only
 * removable once it holds no projects at all — neither live ones nor projects
 * whose asynchronous deletion is still in flight. A billable Stripe
 * subscription is cancelled before the hard delete, and the cached org API
 * keys are dropped afterwards.
 */
export async function deleteOrganization(
  req: NextApiRequest,
  res: NextApiResponse,
  organizationId: string,
) {
  const existing = await prisma.organization.findUnique({
    where: { id: organizationId },
  });
  if (!existing) {
    return res.status(404).json({ error: "Organization not found" });
  }

  const [liveProjectCount, projectCount] = await Promise.all([
    prisma.project.count({
      where: { orgId: organizationId, deletedAt: null },
    }),
    prisma.project.count({ where: { orgId: organizationId } }),
  ]);

  if (liveProjectCount > 0) {
    return res.status(400).json({
      error: PROJECTS_REMAIN_ERROR,
      message:
        "Please delete or transfer all projects before deleting the organization.",
    });
  }
  if (projectCount > 0) {
    return res.status(400).json({
      error: PROJECTS_REMAIN_ERROR,
      message:
        "Deletion of your projects is still being processed, please try deleting the organization later",
    });
  }

  // Never delete the local organization while leaving a billable Stripe
  // subscription behind. A Stripe failure aborts the deletion.
  await cancelSubscriptionImmediatelyForOrganization(organizationId);

  // Drop the cached API keys BEFORE the delete, not after: the helper resolves the
  // keys to evict by reading `api_keys`, and the organization delete cascades those
  // rows away. Invalidating afterwards therefore found nothing to evict and left a
  // stale Redis entry that kept authenticating a deleted organization's key for the
  // remaining TTL (LITE_FUSE_CACHE_API_KEY_ENABLED defaults to true, 300s).
  // `deleteProject` already invalidates first for the same reason.
  await new ApiAuthService(prisma, redis).invalidateCachedOrgApiKeys(
    organizationId,
  );

  const deleted = await prisma.organization.delete({
    where: { id: organizationId },
  });

  await auditLog({
    apiKeyId: "admin-api",
    orgId: organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    action: "delete",
    before: deleted,
  });

  logger.info("Admin API deleted an organization", { organizationId });

  res.status(200).json({ success: true });
}
