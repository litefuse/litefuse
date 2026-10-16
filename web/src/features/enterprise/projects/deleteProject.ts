import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import {
  logger,
  redis,
  QueueJobs,
  ProjectDeleteQueue,
  type ApiAccessScope,
} from "@langfuse/shared/src/server";
import { randomUUID } from "crypto";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";

/**
 * Delete a project (DELETE /api/public/projects/{id}).
 *
 * The order matters: cached keys are dropped first (otherwise they would stay
 * valid), project scoped keys are removed from Postgres, the project itself is
 * only soft deleted, the change is audited, and the actual data removal is
 * handed over to the worker.
 */
export async function deleteProject(
  req: NextApiRequest,
  res: NextApiResponse,
  projectId: string,
  scope: ApiAccessScope,
) {
  try {
    const apiKeys = new ApiAuthService(prisma, redis);

    await apiKeys.invalidateCachedProjectApiKeys(projectId);

    await prisma.apiKey.deleteMany({
      where: { projectId, scope: "PROJECT" },
    });

    // Soft delete, constrained by id + orgId so that no other organization's
    // project can be reached through this route.
    const removedProject = await prisma.project.update({
      where: { id: projectId, orgId: scope.orgId },
      data: { deletedAt: new Date() },
    });

    await auditLog({
      apiKeyId: scope.apiKeyId,
      orgId: scope.orgId,
      projectId,
      resourceType: "project",
      resourceId: projectId,
      before: removedProject,
      action: "delete",
    });

    const deletionQueue = ProjectDeleteQueue.getInstance();
    if (!deletionQueue) {
      logger.error("Project delete queue is unavailable");
      return res.status(500).json({ message: "Internal server error" });
    }

    await deletionQueue.add(QueueJobs.ProjectDelete, {
      timestamp: new Date(),
      id: randomUUID(),
      payload: { projectId, orgId: scope.orgId },
      name: QueueJobs.ProjectDelete,
    });

    return res.status(202).json({
      success: true,
      message:
        "The project is queued for deletion and will be removed in the background.",
    });
  } catch (error) {
    logger.error("Could not delete the project", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
