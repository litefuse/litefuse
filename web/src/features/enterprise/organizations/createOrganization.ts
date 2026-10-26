import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma, type Prisma } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { organizationNameSchema } from "@/src/features/organizations/utils/organizationNameSchema";

/**
 * Result of reading the optional `metadata` field of an admin request body.
 */
type MetadataField =
  | { ok: true; value: Prisma.InputJsonValue | undefined }
  | { ok: false; error: string };

/**
 * Admin callers may send `metadata` either as a JSON object or as a string that
 * encodes one. Anything else — arrays, null, scalars, malformed JSON — is
 * rejected here so that only a JSON object is ever handed to the database.
 */
function readMetadata(body: unknown): MetadataField {
  const requestBody = body as { metadata?: unknown } | null | undefined;
  const rawMetadata = requestBody?.metadata;

  if (rawMetadata === undefined) {
    return { ok: true, value: undefined };
  }

  let candidate: unknown = rawMetadata;
  if (typeof rawMetadata !== "object") {
    try {
      candidate = JSON.parse(String(rawMetadata));
    } catch (parseError) {
      return {
        ok: false,
        error: `Invalid metadata. Should be a valid JSON object: ${parseError}`,
      };
    }
  }

  const isJsonObject =
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate);

  if (!isJsonObject) {
    return {
      ok: false,
      error: "Invalid metadata. Should be a valid JSON object.",
    };
  }

  return { ok: true, value: candidate as Prisma.InputJsonValue };
}

/**
 * Create an organization (POST /api/admin/organizations, instance admin).
 */
export async function createOrganization(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const validationResult = organizationNameSchema.safeParse(req.body);
  if (!validationResult.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: validationResult.error.format(),
    });
  }

  const metadataField = readMetadata(req.body);
  if (!metadataField.ok) {
    return res.status(400).json({ error: metadataField.error });
  }

  const organization = await prisma.organization.create({
    data: {
      name: validationResult.data.name,
      metadata: metadataField.value,
    },
    select: {
      id: true,
      name: true,
      createdAt: true,
      metadata: true,
      projects: {
        select: {
          id: true,
          name: true,
          metadata: true,
          createdAt: true,
          updatedAt: true,
        },
        where: { deletedAt: null },
      },
    },
  });

  await auditLog({
    apiKeyId: "admin-api",
    orgId: organization.id,
    resourceType: "organization",
    resourceId: organization.id,
    action: "create",
    after: organization,
  });

  logger.info("Admin API created an organization", {
    organizationId: organization.id,
  });

  return res.status(201).json({
    id: organization.id,
    name: organization.name,
    createdAt: organization.createdAt,
    metadata: organization.metadata ?? {},
    projects: organization.projects,
  });
}
