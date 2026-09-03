import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import {
  logger,
  provisionSplitForNewProject,
  type ApiAccessScope,
} from "@langfuse/shared/src/server";
import { projectNameSchema } from "@/src/features/auth/lib/projectNameSchema";
import { projectRetentionSchema } from "@/src/features/auth/lib/projectRetentionSchema";
import { hasEntitlementBasedOnPlan } from "@/src/features/entitlements/server/hasEntitlement";
import { getDefaultScoreConfigsForProject, RETENTION_FLOOR_DAYS } from "@langfuse/shared";

/**
 * Create a project (POST /api/public/projects).
 * Validates name / metadata / retention, then creates the project + default score configs in a transaction.
 * scope comes from requireAdminApi and contains orgId and plan.
 */
export async function createProject(
  req: NextApiRequest,
  res: NextApiResponse,
  scope: ApiAccessScope,
) {
  try {
    const { name, retention, metadata } = req.body;

    try {
      projectNameSchema.parse({ name });
    } catch {
      return res.status(400).json({
        message: "Invalid project name. Should be between 3 and 60 characters.",
      });
    }

    let parsedMetadata = metadata;
    if (metadata !== undefined && typeof metadata !== "object") {
      try {
        parsedMetadata = JSON.parse(metadata);
      } catch (error) {
        return res.status(400).json({
          message: `Invalid metadata. Should be a valid JSON object: ${error}`,
        });
      }
    }
    if (
      parsedMetadata !== undefined &&
      (typeof parsedMetadata !== "object" ||
        parsedMetadata === null ||
        Array.isArray(parsedMetadata))
    ) {
      return res.status(400).json({
        message: "Invalid metadata. Should be a valid JSON object.",
      });
    }

    if (retention !== undefined) {
      try {
        projectRetentionSchema.parse({ retention });
      } catch {
        return res.status(400).json({
          message: `Invalid retention value. Must be 0 or at least ${RETENTION_FLOOR_DAYS} days.`,
        });
      }

      if (retention > 0) {
        const hasRetentionEntitlement = hasEntitlementBasedOnPlan({
          entitlement: "data-retention",
          plan: scope.plan,
        });
        if (!hasRetentionEntitlement) {
          return res.status(403).json({
            message:
              "The data-retention entitlement is required to set a non-zero retention period.",
          });
        }
      }
    }

    const existingProject = await prisma.project.findFirst({
      where: { name, orgId: scope.orgId, deletedAt: null },
    });
    if (existingProject) {
      return res.status(409).json({
        message: "A project with this name already exists in your organization",
      });
    }

    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          name,
          orgId: scope.orgId,
          retentionDays: retention,
          metadata: parsedMetadata,
        },
      });

      await tx.scoreConfig.createMany({
        data: getDefaultScoreConfigsForProject(created.id),
      });

      return created;
    });

    // Universal Doris table split: every new project must get its own Doris tables.
    // Matches project creation in the UI (projectsRouter.create): if designation fails,
    // delete the just-created project so the request fails cleanly instead of leaving a project without tables.
    try {
      await provisionSplitForNewProject(project.id);
    } catch (e) {
      await prisma.project
        .delete({ where: { id: project.id } })
        .catch(() => undefined);
      throw e;
    }

    return res.status(201).json({
      id: project.id,
      name: project.name,
      metadata: project.metadata ?? {},
      ...(project.retentionDays
        ? { retentionDays: project.retentionDays }
        : {}),
    });
  } catch (error) {
    logger.error("Failed to create project", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
