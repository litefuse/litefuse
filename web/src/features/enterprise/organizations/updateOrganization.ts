import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma, type Prisma } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
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
 * Update an organization (PUT /api/admin/organizations/{id}, instance admin).
 */
export async function updateOrganization(
  req: NextApiRequest,
  res: NextApiResponse,
  organizationId: string,
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

  const existing = await prisma.organization.findUnique({
    where: { id: organizationId },
  });
  if (!existing) {
    return res.status(404).json({ error: "Organization not found" });
  }

  const updated = await prisma.organization.update({
    where: { id: organizationId },
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

  logger.info("Admin API updated an organization", {
    organizationId,
  });

  return res.status(200).json({
    id: updated.id,
    name: updated.name,
    createdAt: updated.createdAt,
    metadata: updated.metadata ?? {},
    projects: updated.projects,
  });
}
