import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";

/**
 * List all organizations (GET /api/admin/organizations, instance admin).
 *
 * Only live projects are reported; each organization always carries a JSON
 * object as `metadata`, defaulting to `{}` when none was set.
 */
export async function listOrganizations(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const organizationRows = await prisma.organization.findMany({
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

  return res.status(200).json({
    organizations: organizationRows.map((organization) => ({
      ...organization,
      metadata: organization.metadata ?? {},
    })),
  });
}
