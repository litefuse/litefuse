import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";

/**
 * List project memberships (GET /api/public/projects/{id}/memberships).
 *
 * Only explicit project-level memberships are reported: the users whose role
 * on this project overrides the organization role they would otherwise
 * inherit. Results are scoped to the caller's organization.
 */
export async function listProjectMemberships(
  req: NextApiRequest,
  res: NextApiResponse,
  projectId: string,
  orgId: string,
) {
  const rows = await prisma.projectMembership.findMany({
    where: { projectId, organizationMembership: { orgId } },
    include: {
      user: { select: { id: true, email: true, name: true } },
    },
  });

  const memberships = rows.map(({ userId, role, user }) => ({
    userId,
    role,
    email: user.email,
    name: user.name,
  }));

  return res.status(200).json({ memberships });
}
