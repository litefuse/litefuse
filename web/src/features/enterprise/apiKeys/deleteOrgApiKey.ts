import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import { logger, redis } from "@langfuse/shared/src/server";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";

/** Answer used whenever the addressed key cannot be resolved. */
const API_KEY_NOT_FOUND_ERROR = "API key not found";

/** Acknowledgement body of a successful delete. */
const DELETE_SUCCEEDED_BODY = { success: true };

/**
 * Delete an organization-level API key (instance-admin entry).
 *
 * DELETE /api/admin/organizations/{id}/apiKeys/{keyId}
 */
export async function deleteOrgApiKey(
  req: NextApiRequest,
  res: NextApiResponse,
  orgId: string,
  apiKeyId: string,
  actorId: string,
) {
  const apiKey = await prisma.apiKey.findUnique({
    where: { id: apiKeyId, orgId, scope: "ORGANIZATION" },
  });

  if (!apiKey) {
    return res.status(404).json({ error: API_KEY_NOT_FOUND_ERROR });
  }

  const apiAuth = new ApiAuthService(prisma, redis);
  const removed = await apiAuth.deleteApiKey(apiKeyId, orgId, "ORGANIZATION");

  if (!removed) {
    return res.status(500).json({
      error: "The API key could not be removed.",
    });
  }

  await auditLog({
    apiKeyId: actorId,
    orgId,
    resourceType: "apiKey",
    resourceId: apiKeyId,
    action: "delete",
  });

  logger.info(`Removed API key ${apiKeyId} from organization ${orgId}`);

  return res.status(200).json(DELETE_SUCCEEDED_BODY);
}
