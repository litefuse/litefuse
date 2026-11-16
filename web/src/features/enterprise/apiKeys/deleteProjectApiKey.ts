import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import {
  logger,
  redis,
  type ApiAccessScope,
} from "@langfuse/shared/src/server";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";

/** Answer used whenever the addressed key cannot be resolved. */
const API_KEY_NOT_FOUND_MESSAGE = "API key not found";

/** Acknowledgement body of a successful delete. */
const DELETE_SUCCEEDED_BODY = { success: true };

/**
 * Delete a project-level API key
 * (DELETE /api/public/projects/{id}/apiKeys/{keyId}).
 */
export async function deleteProjectApiKey(
  req: NextApiRequest,
  res: NextApiResponse,
  projectId: string,
  apiKeyId: string,
  scope: ApiAccessScope,
) {
  const apiKey = await prisma.apiKey.findUnique({
    where: { id: apiKeyId, projectId, scope: "PROJECT" },
  });

  if (!apiKey) {
    return res.status(404).json({ message: API_KEY_NOT_FOUND_MESSAGE });
  }

  const apiAuth = new ApiAuthService(prisma, redis);
  const removed = await apiAuth.deleteApiKey(apiKeyId, projectId, "PROJECT");

  if (!removed) {
    return res.status(500).json({
      message: "The API key could not be removed.",
    });
  }

  await auditLog({
    apiKeyId: scope.apiKeyId,
    orgId: scope.orgId,
    projectId,
    resourceType: "apiKey",
    resourceId: apiKeyId,
    action: "delete",
  });

  logger.info(`Removed API key ${apiKeyId} from project ${projectId}`);

  return res.status(200).json(DELETE_SUCCEEDED_BODY);
}
