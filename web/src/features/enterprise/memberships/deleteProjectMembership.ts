import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import { z } from "zod/v4";

const DeleteProjectMembershipBody = z.object({
  userId: z.string(),
});

/**
 * Delete a project membership (DELETE /api/public/projects/{id}/memberships).
 * Verifies the membership exists and belongs to the current organization before deleting.
 */
export async function deleteProjectMembership(
  req: NextApiRequest,
  res: NextApiResponse,
  projectId: string,
  orgId: string,
) {
  const parsed = DeleteProjectMembershipBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
  }

  const membership = await prisma.projectMembership.findUnique({
    where: {
      projectId_userId: { userId: parsed.data.userId, projectId },
    },
    include: {
      organizationMembership: { select: { orgId: true } },
    },
  });

  if (!membership) {
    return res.status(404).json({ error: "Project membership not found" });
  }

  if (membership.organizationMembership.orgId !== orgId) {
    return res.status(403).json({
      error: "Project membership does not belong to this organization",
    });
  }

  await prisma.projectMembership.delete({
    where: {
      projectId_userId: { userId: parsed.data.userId, projectId },
    },
  });

  return res.status(200).json({
    message: "Project membership removed",
    userId: parsed.data.userId,
  });
}
