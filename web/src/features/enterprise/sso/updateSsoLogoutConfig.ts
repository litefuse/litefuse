import { type NextApiRequest, type NextApiResponse } from "next";
import { z } from "zod/v4";
import { prisma } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
import { AdminApiAuthService } from "@/src/server/adminApiAuth";
import { isMultiTenantSsoAvailable } from "./ssoAvailable";
import { ssoLogoutConfigSchema } from "./ssoConfigSchema";
import { ssoErrorContext } from "./ssoErrorContext";

const updateSchema = z
  .object({
    domain: z.string().min(1).toLowerCase(),
    logout: ssoLogoutConfigSchema.nullable(),
  })
  .strict();

/** Update logout independently of the enterprise's encrypted login credentials. */
export async function updateSsoLogoutConfig(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  if (!isMultiTenantSsoAvailable) {
    return res
      .status(403)
      .json({ error: "Multi-tenant SSO is not available on your instance" });
  }
  if (
    !AdminApiAuthService.handleAdminAuth(req, res, {
      isAllowedOnLangfuseCloud: true,
    })
  )
    return;

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "Invalid SSO logout configuration" });

  try {
    const { domain, logout } = parsed.data;
    const existing = await prisma.ssoConfig.findUnique({ where: { domain } });
    if (!existing)
      return res.status(404).json({ error: "SSO configuration not found" });
    if (
      !existing.authConfig ||
      typeof existing.authConfig !== "object" ||
      Array.isArray(existing.authConfig)
    ) {
      return res
        .status(409)
        .json({ error: "Custom enterprise credentials are required" });
    }

    const authConfig = { ...existing.authConfig };
    if (logout === null) delete authConfig.logout;
    else authConfig.logout = logout;
    const updated = await prisma.ssoConfig.updateMany({
      where: { domain, authConfig: { equals: existing.authConfig } },
      data: { authConfig },
    });
    if (!updated.count) {
      return res
        .status(409)
        .json({ error: "SSO configuration changed; retry the update" });
    }
    return res
      .status(200)
      .json({ message: "SSO logout configuration updated" });
  } catch (error) {
    logger.error(
      "Failed to update Enterprise SSO logout configuration",
      ssoErrorContext(error),
    );
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
