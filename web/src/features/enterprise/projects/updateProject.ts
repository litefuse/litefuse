import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma, type Prisma } from "@langfuse/shared/src/db";
import {
  logger,
  enqueueDorisSplitTableProvisioning,
  type ApiAccessScope,
} from "@langfuse/shared/src/server";
import { projectNameSchema } from "@/src/features/auth/lib/projectNameSchema";
import { projectRetentionSchema } from "@/src/features/auth/lib/projectRetentionSchema";
import { hasEntitlementBasedOnPlan } from "@/src/features/entitlements/server/hasEntitlement";
import { RETENTION_FLOOR_DAYS } from "@langfuse/shared";

type MetadataUpdate =
  | { state: "absent" }
  | { state: "object"; value: Prisma.InputJsonValue }
  | { state: "undecodable"; reason: string }
  | { state: "wrong-type" };

/**
 * `metadata` may be sent as a JSON object or as a JSON encoded string. Only the
 * decoded object is kept; every other outcome is described so the handler can
 * answer with the right 400.
 */
function normaliseMetadataUpdate(input: unknown): MetadataUpdate {
  if (input === undefined) {
    return { state: "absent" };
  }

  let candidate: unknown = input;
  if (typeof input === "string") {
    try {
      candidate = JSON.parse(input);
    } catch (error) {
      return { state: "undecodable", reason: `${error}` };
    }
  }

  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return { state: "wrong-type" };
  }

  return { state: "object", value: candidate as Prisma.InputJsonValue };
}

/**
 * Update a project (PUT /api/public/projects/{id}).
 *
 * The where clause pins both the project id and the organization id, so a key
 * of one organization can never modify a project of another one.
 */
export async function updateProject(
  req: NextApiRequest,
  res: NextApiResponse,
  projectId: string,
  scope: ApiAccessScope,
) {
  try {
    const {
      name,
      retention: requestedRetention,
      metadata: rawMetadata,
    } = req.body;

    if (!projectNameSchema.safeParse({ name }).success) {
      return res.status(400).json({
        message: "Invalid project name. Use 3 to 60 characters.",
      });
    }

    const metadata = normaliseMetadataUpdate(rawMetadata);
    if (metadata.state === "undecodable") {
      return res.status(400).json({
        message: `Metadata is not decodable JSON: ${metadata.reason}`,
      });
    }
    if (metadata.state === "wrong-type") {
      return res.status(400).json({
        message: "Metadata must be a JSON object.",
      });
    }

    if (requestedRetention !== undefined) {
      const retentionIsValid = projectRetentionSchema.safeParse({
        retention: requestedRetention,
      }).success;
      if (!retentionIsValid) {
        return res.status(400).json({
          message: `Invalid retention value. Must be 0 or at least ${RETENTION_FLOOR_DAYS} days.`,
        });
      }

      if (
        requestedRetention > 0 &&
        !hasEntitlementBasedOnPlan({
          entitlement: "data-retention",
          plan: scope.plan,
        })
      ) {
        return res.status(403).json({
          message:
            "A retention period above zero requires the data-retention entitlement.",
        });
      }
    }

    // Only the fields the caller actually sent are patched; omitted ones keep
    // their stored value.
    const patch: {
      name: string;
      retentionDays?: number;
      metadata?: Prisma.InputJsonValue;
    } = { name };
    if (requestedRetention !== undefined) {
      patch.retentionDays = requestedRetention;
    }
    if (metadata.state === "object") {
      patch.metadata = metadata.value;
    }

    const savedProject = await prisma.project.update({
      where: { id: projectId, orgId: scope.orgId },
      data: patch,
      select: { id: true, name: true, retentionDays: true, metadata: true },
    });

    // Project.retentionDays is the single source of truth, so a changed value
    // also has to reach the split tables' dynamic_partition TTL. The enqueue is
    // idempotent and a no-op while no control row exists (compare setRetention
    // in the UI's projectsRouter).
    if (requestedRetention !== undefined) {
      await enqueueDorisSplitTableProvisioning(projectId).catch((error) =>
        logger.error(
          `[table-split] could not enqueue TTL re-provisioning for ${projectId}`,
          error,
        ),
      );
    }

    const payload: Record<string, unknown> = {
      id: savedProject.id,
      name: savedProject.name,
      metadata: savedProject.metadata ?? {},
    };
    if (savedProject.retentionDays) {
      payload.retentionDays = savedProject.retentionDays;
    }

    return res.status(200).json(payload);
  } catch (error) {
    logger.error("Could not update the project", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
