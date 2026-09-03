import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import {
  logger,
  enqueueDorisSplitTableProvisioning,
  type ApiAccessScope,
} from "@langfuse/shared/src/server";
import { projectNameSchema } from "@/src/features/auth/lib/projectNameSchema";
import { projectRetentionSchema } from "@/src/features/auth/lib/projectRetentionSchema";
import { hasEntitlementBasedOnPlan } from "@/src/features/entitlements/server/hasEntitlement";

/**
 * Update a project (PUT /api/public/projects/{id}).
 * The where clause constrains both id and orgId to prevent cross-organization operations.
 */
export async function updateProject(
  req: NextApiRequest,
  res: NextApiResponse,
  projectId: string,
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
          message: "Invalid retention value. Must be 0 or at least 7 days.",
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

    const updatedProject = await prisma.project.update({
      where: { id: projectId, orgId: scope.orgId },
      data: {
        name,
        ...(retention !== undefined ? { retentionDays: retention } : {}),
        ...(metadata !== undefined ? { metadata: parsedMetadata } : {}),
      },
      select: {
        id: true,
        name: true,
        retentionDays: true,
        metadata: true,
      },
    });

    // Retention has a single source of truth in Project.retentionDays: changing it must also update
    // the split tables' dynamic_partition TTL (idempotent ALTER; no-op when there is no control row).
    // Matches the UI's setRetention (projectsRouter).
    if (retention !== undefined) {
      await enqueueDorisSplitTableProvisioning(projectId).catch((e) =>
        logger.error(
          `[table-split] TTL re-provision enqueue for ${projectId} failed`,
          e,
        ),
      );
    }

    return res.status(200).json({
      id: updatedProject.id,
      name: updatedProject.name,
      metadata: updatedProject.metadata ?? {},
      ...(updatedProject.retentionDays
        ? { retentionDays: updatedProject.retentionDays }
        : {}),
    });
  } catch (error) {
    logger.error("Failed to update project", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
