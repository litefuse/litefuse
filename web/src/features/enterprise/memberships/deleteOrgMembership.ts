import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import { Role } from "@langfuse/shared";
import { z } from "zod/v4";

const DeleteOrgMembershipBody = z.object({
  userId: z.string(),
});

/**
 * Delete an organization membership (DELETE /api/public/organizations/memberships).
 * Uses deleteMany so a missing membership does not throw.
 */
export async function deleteOrgMembership(
  req: NextApiRequest,
  res: NextApiResponse,
  orgId: string,
) {
  const parsed = DeleteOrgMembershipBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
  }

  // Last-OWNER protection (matches the UI's membersRouter.deleteOrgMembership):
  // do not allow deleting the only OWNER of the organization, so it never ends up ownerless.
  const existing = await prisma.organizationMembership.findUnique({
    where: { orgId_userId: { orgId, userId: parsed.data.userId } },
  });
  if (existing?.role === Role.OWNER) {
    const owners = await prisma.organizationMembership.count({
      where: { orgId, role: Role.OWNER },
    });
    if (owners === 1) {
      return res.status(403).json({
        error:
          "Cannot remove the last owner of an organization. Assign new owner or delete organization.",
      });
    }
  }

  await prisma.organizationMembership.deleteMany({
    where: { orgId, userId: parsed.data.userId },
  });

  return res.status(200).json({
    message: "Organization membership removed",
    userId: parsed.data.userId,
  });
}
