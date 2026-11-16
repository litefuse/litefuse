import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { requireAdminApiScope } from "@/src/features/public-api/server/adminApiGuard";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import { prisma } from "@langfuse/shared/src/db";
import { logger, redis } from "@langfuse/shared/src/server";
import { type NextApiRequest, type NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await runMiddleware(req, res, cors);

  if (req.method !== "GET" && req.method !== "POST") {
    logger.error(
      `Method not allowed for ${req.method} on /api/public/projects`,
    );
    return res.status(405).json({ message: "Method not allowed" });
  }

  // POST: create a project (organization-level key + admin-api entitlement).
  //
  // The enterprise half of a deliberately mixed route (see ANNEX A/B of
  // LICENSE-EE): the GET below is the community operation SDKs use for
  // `auth_check`, and only this branch is licensed material.
  //
  // ORDER MATTERS. The guard runs first and is MIT code, so an unauthenticated or
  // unentitled request — which is every POST on a community deployment — is
  // rejected before any licensed module is loaded. Only an authorized request
  // reaches the dynamic import of the enterprise implementation.
  if (req.method === "POST") {
    const scope = await requireAdminApiScope(req, res);
    if (!scope) return;

    const { createProject } = await import(
      "@/src/features/enterprise/projects/createProject"
    );
    return createProject(req, res, scope);
  }

  // GET: look up the project by project key (original logic preserved)
  const authCheck = await new ApiAuthService(
    prisma,
    redis,
  ).verifyAuthHeaderAndReturnScope(req.headers.authorization);
  if (!authCheck.validKey) {
    return res.status(401).json({
      message: authCheck.error,
    });
  }

  if (authCheck.scope.accessLevel !== "project" || !authCheck.scope.projectId) {
    return res.status(403).json({
      message: "Invalid API key. Are you using an organization key?",
    });
  }

  try {
    // Do not apply rate limits as it can break applications on lower tier plans when using auth_check in prod

    const projects = await prisma.project.findMany({
      select: {
        id: true,
        name: true,
        retentionDays: true,
        metadata: true,
        organization: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      where: {
        id: authCheck.scope.projectId,
        deletedAt: null,
      },
    });

    return res.status(200).json({
      data: projects.map((project) => ({
        id: project.id,
        name: project.name,
        organization: {
          id: project.organization.id,
          name: project.organization.name,
        },
        metadata: project.metadata ?? {},
        ...(project.retentionDays // Do not add if null or 0
          ? { retentionDays: project.retentionDays }
          : {}),
      })),
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
