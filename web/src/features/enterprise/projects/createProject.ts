import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma, type Prisma } from "@langfuse/shared/src/db";
import {
  logger,
  provisionSplitForNewProject,
  type ApiAccessScope,
} from "@langfuse/shared/src/server";
import { projectNameSchema } from "@/src/features/auth/lib/projectNameSchema";
import { projectRetentionSchema } from "@/src/features/auth/lib/projectRetentionSchema";
import { hasEntitlementBasedOnPlan } from "@/src/features/entitlements/server/hasEntitlement";
import {
  getDefaultScoreConfigsForProject,
  RETENTION_FLOOR_DAYS,
} from "@langfuse/shared";

type MetadataField =
  | { state: "missing" }
  | { state: "object"; value: Prisma.InputJsonValue }
  | { state: "undecodable"; reason: string }
  | { state: "wrong-type" };

/**
 * `metadata` arrives either as an already parsed object or as a JSON encoded
 * string. Both spellings are normalised here; anything that does not end up as
 * a plain JSON object is reported so the caller can answer with a 400.
 */
function readMetadataField(input: unknown): MetadataField {
  if (input === undefined) {
    return { state: "missing" };
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
 * Create a project (POST /api/public/projects).
 *
 * `scope` is produced by requireAdminApi and pins the target organization plus
 * the plan used for entitlement checks. Name, metadata and retention are
 * validated first, then the project and its default score configs are written
 * in a single transaction.
 */
export async function createProject(
  req: NextApiRequest,
  res: NextApiResponse,
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

    const metadata = readMetadataField(rawMetadata);
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

    // Soft deleted projects keep their name, so only live ones block a new one.
    const liveProjectWithName = await prisma.project.findFirst({
      where: { orgId: scope.orgId, name, deletedAt: null },
      select: { id: true },
    });
    if (liveProjectWithName) {
      return res.status(409).json({
        message: "Your organization already has a project with this name.",
      });
    }

    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          name,
          orgId: scope.orgId,
          retentionDays: requestedRetention,
          metadata: metadata.state === "object" ? metadata.value : undefined,
        },
      });

      await tx.scoreConfig.createMany({
        data: getDefaultScoreConfigsForProject(created.id),
      });

      return created;
    });

    // Every project owns its own Doris split tables. Same contract as project
    // creation in the UI (projectsRouter.create): if provisioning fails the
    // freshly created project is removed again, so the caller never ends up
    // with a project that has no tables behind it.
    try {
      await provisionSplitForNewProject(project.id);
    } catch (error) {
      await prisma.project
        .delete({ where: { id: project.id } })
        .catch(() => undefined);
      throw error;
    }

    const payload: Record<string, unknown> = {
      id: project.id,
      name: project.name,
      metadata: project.metadata ?? {},
    };
    if (project.retentionDays) {
      payload.retentionDays = project.retentionDays;
    }

    return res.status(201).json(payload);
  } catch (error) {
    logger.error("Could not create the project", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
