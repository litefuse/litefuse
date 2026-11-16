import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import { logger, type ApiAccessScope } from "@langfuse/shared/src/server";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { createAndAddApiKeysToDb } from "@langfuse/shared/src/server/auth/apiKeys";
import { z } from "zod/v4";

const CreateProjectApiKeyBody = z.object({
  note: z.string().optional(),
  publicKey: z.string().optional(),
  secretKey: z.string().optional(),
});

const PUBLIC_KEY_PREFIX = "pk-lf-";
const SECRET_KEY_PREFIX = "sk-lf-";

/**
 * Prisma marks a clash on `publicKey` / `secretKey` with error code P2002. Some
 * driver level failures only leave the unique constraint text behind, so both
 * spellings are treated as the same problem.
 */
function isDuplicateKeyFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ((error as { code?: unknown }).code === "P2002") {
    return true;
  }
  return error instanceof Error && /unique constraint/i.test(error.message);
}

/**
 * Create a project-level API key (POST /api/public/projects/{id}/apiKeys).
 *
 * The caller may dictate the key pair instead of letting us generate one, but
 * then both halves have to be sent and have to look like regular keys.
 */
export async function createProjectApiKey(
  req: NextApiRequest,
  res: NextApiResponse,
  projectId: string,
  scope: ApiAccessScope,
) {
  const body = CreateProjectApiKeyBody.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({
      message: "Invalid request body",
      details: body.error.format(),
    });
  }

  const { note, publicKey, secretKey } = body.data;

  let predefinedKeys: { publicKey: string; secretKey: string } | undefined;
  if (publicKey || secretKey) {
    if (!publicKey || !secretKey) {
      return res.status(400).json({
        message:
          "Both publicKey and secretKey are required together to register a custom key pair.",
      });
    }

    if (!publicKey.startsWith(PUBLIC_KEY_PREFIX)) {
      return res.status(400).json({
        message: `publicKey has to use the '${PUBLIC_KEY_PREFIX}' prefix`,
      });
    }

    if (!secretKey.startsWith(SECRET_KEY_PREFIX)) {
      return res.status(400).json({
        message: `secretKey has to use the '${SECRET_KEY_PREFIX}' prefix`,
      });
    }

    predefinedKeys = { publicKey, secretKey };
  }

  try {
    const apiKeyMeta = await createAndAddApiKeysToDb({
      prisma,
      entityId: projectId,
      note,
      scope: "PROJECT",
      predefinedKeys,
    });

    await auditLog({
      apiKeyId: scope.apiKeyId,
      orgId: scope.orgId,
      projectId,
      resourceType: "apiKey",
      resourceId: apiKeyMeta.id,
      action: "create",
    });

    logger.info(`Registered API key ${apiKeyMeta.id} on project ${projectId}`);

    return res.status(201).json(apiKeyMeta);
  } catch (error) {
    if (isDuplicateKeyFailure(error)) {
      return res.status(409).json({
        message:
          "That publicKey or secretKey is already in use by another API key.",
      });
    }

    logger.error("Could not create the project API key", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
