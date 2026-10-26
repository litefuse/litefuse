import { prisma } from "@langfuse/shared/src/db";
import { encrypt } from "@langfuse/shared/encryption";
import { type NextApiRequest, type NextApiResponse } from "next";
import { env } from "@/src/env.mjs";
import { logger } from "@langfuse/shared/src/server";
import { AdminApiAuthService } from "@/src/server/adminApiAuth";
import { isMultiTenantSsoAvailable } from "@/src/features/auth/sso/isMultiTenantSsoAvailable";
import { ssoProviderSchema } from "@/src/features/enterprise/sso/ssoConfigSchema";

/**
 * Create a multi-tenant SSO config (POST /api/auth/add-sso-config).
 *
 * Only available where multi-tenant SSO is enabled, authenticated with the
 * ADMIN_API_KEY, and the client secret is encrypted before it is stored.
 */
export async function createSsoConfig(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  try {
    if (!isMultiTenantSsoAvailable) {
      res.status(403).json({
        error: "Multi-tenant SSO is not enabled on this instance",
      });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    if (!env.ADMIN_API_KEY) {
      res.status(500).json({ error: "ADMIN_API_KEY is not set" });
      return;
    }

    if (!env.ENCRYPTION_KEY) {
      res.status(500).json({
        error: "ENCRYPTION_KEY environment variable is missing",
      });
      return;
    }

    if (
      !AdminApiAuthService.handleAdminAuth(req, res, {
        isAllowedOnLangfuseCloud: true,
      })
    ) {
      return;
    }

    const parsedBody = ssoProviderSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error });
      return;
    }

    const ssoConfig = parsedBody.data;

    // At most one SSO configuration may exist per domain, so check for an
    // existing entry before writing.
    const duplicate = await prisma.ssoConfig.findUnique({
      where: { domain: ssoConfig.domain },
    });
    if (duplicate) {
      logger.info("Rejected a duplicate SSO configuration", {
        domain: ssoConfig.domain,
      });
      res.status(409).json({
        error: `Domain ${ssoConfig.domain} already has an SSO configuration`,
      });
      return;
    }

    const encryptedAuthConfig = ssoConfig.authConfig
      ? {
          ...ssoConfig.authConfig,
          clientSecret: encrypt(ssoConfig.authConfig.clientSecret),
        }
      : undefined;

    await prisma.ssoConfig.create({
      data: {
        domain: ssoConfig.domain,
        authProvider: ssoConfig.authProvider,
        authConfig: encryptedAuthConfig,
      },
    });

    res.status(201).json({ message: "SSO configuration created successfully" });
  } catch (e) {
    logger.error("Could not store the new SSO configuration", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
