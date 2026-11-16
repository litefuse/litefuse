import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import { Role } from "@langfuse/shared";
import { z } from "zod/v4";

const ProjectMembershipBody = z.object({
  userId: z.string(),
  role: z.enum(Role),
});

/**
 * Create or update a project membership (PUT /api/public/projects/{id}/memberships).
 *
 * A project membership always hangs off an organization membership, so the
 * organization membership is resolved first — it also carries the email and
 * name returned to the caller — and only then is the project role upserted.
 */
export async function upsertProjectMembership(
  req: NextApiRequest,
  res: NextApiResponse,
  projectId: string,
  orgId: string,
) {
  const parsed = ProjectMembershipBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
  }

  const { userId, role } = parsed.data;

  const organizationMembership = await prisma.organizationMembership.findUnique(
    {
      where: { orgId_userId: { orgId, userId } },
      include: { user: { select: { email: true, name: true } } },
    },
  );

  if (!organizationMembership) {
    return res.status(404).json({
      error: "User does not belong to this organization",
    });
  }

  const membership = await prisma.projectMembership.upsert({
    where: { projectId_userId: { projectId, userId } },
    update: { role },
    create: {
      userId,
      projectId,
      role,
      orgMembershipId: organizationMembership.id,
    },
  });

  return res.status(200).json({
    userId: membership.userId,
    role: membership.role,
    email: organizationMembership.user.email,
    name: organizationMembership.user.name,
  });
}
