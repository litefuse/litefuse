import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import {
  parseRequestedName,
  parseRequestedRole,
  toScimUser,
} from "@/src/features/public-api/server/scimUser";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { prisma, type Role, type User } from "@langfuse/shared/src/db";
import { logger, redis } from "@langfuse/shared/src/server";
import { type NextApiRequest, type NextApiResponse } from "next";

const LAST_OWNER_MESSAGE =
  "Cannot remove the last owner of an organization. Assign new owner or delete organization.";

/**
 * Last-OWNER protection, mirroring the invariant that the tRPC membersRouter and
 * the REST deleteOrgMembership/upsertOrgMembership handlers already enforce:
 * an organization must never lose its last OWNER, otherwise nobody can manage it
 * anymore. SCIM deprovisioning/demotion is the only membership path that could
 * silently violate it.
 *
 * `nextRole` describes what the request would do to the membership:
 *   - `undefined` → no role change (nothing can be orphaned)
 *   - `"OWNER"`   → the user keeps/gets the OWNER role
 *   - any other role, or `null` for deprovisioning → the OWNER role is dropped
 *
 * Returns true when the request was rejected and the 403 response is written.
 */
async function rejectIfLastOwner(
  res: NextApiResponse,
  {
    orgId,
    userId,
    nextRole,
  }: {
    orgId: string;
    userId: string;
    nextRole: Role | null | undefined;
  },
): Promise<boolean> {
  if (nextRole === undefined || nextRole === "OWNER") return false;

  const membership = await prisma.organizationMembership.findUnique({
    where: { orgId_userId: { orgId, userId } },
  });
  if (membership?.role !== "OWNER") return false;

  const owners = await prisma.organizationMembership.count({
    where: { orgId, role: "OWNER" },
  });
  if (owners > 1) return false;

  logger.warn(
    `Refused to remove last OWNER ${userId} from org ${orgId} via SCIM`,
  );
  res.status(403).json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    detail: LAST_OWNER_MESSAGE,
    status: 403,
  });
  return true;
}

/**
 * Provision a user into an organization in response to SCIM `active: true`,
 * optionally applying an explicit role.
 *
 * - `role` given   → the membership is created with it, or updated to it.
 * - `role` omitted → a missing membership is created with NONE while an existing
 *   one is left untouched, so a periodic IdP full-sync that omits `roles` cannot
 *   reset a member back to NONE.
 *
 * An audit-log entry is written only when the state actually changes, so a sync
 * that re-sends the same payload does not flood the audit log.
 *
 * Returns false when the request was rejected and the response is written.
 */
async function provisionMembership({
  res,
  user,
  orgId,
  apiKeyId,
  role,
}: {
  res: NextApiResponse;
  user: User;
  orgId: string;
  apiKeyId: string;
  role?: Role;
}): Promise<boolean> {
  const existing = await prisma.organizationMembership.findUnique({
    where: { orgId_userId: { orgId, userId: user.id } },
  });

  if (existing) {
    if (role === undefined || existing.role === role) return true;

    if (
      await rejectIfLastOwner(res, { orgId, userId: user.id, nextRole: role })
    )
      return false;

    const updated = await prisma.organizationMembership.update({
      where: { orgId_userId: { orgId, userId: user.id } },
      data: { role },
    });
    await auditLog({
      apiKeyId,
      orgId,
      resourceType: "orgMembership",
      resourceId: updated.id,
      action: "update",
      before: existing,
      after: updated,
    });
    logger.info(
      `Updated role for user ${user.id} in org ${orgId} to ${role} via SCIM`,
    );
    return true;
  }

  const created = await prisma.organizationMembership.create({
    data: { userId: user.id, orgId, role: role ?? "NONE" },
  });
  await auditLog({
    apiKeyId,
    orgId,
    resourceType: "orgMembership",
    resourceId: created.id,
    action: "create",
    after: created,
  });
  logger.info(
    `Provisioned user ${user.id} in org ${orgId} with role ${created.role} via SCIM`,
  );
  return true;
}

/**
 * Deprovision a user (SCIM `active: false` or DELETE): removes the organization
 * membership, refusing to remove the last OWNER.
 *
 * The audit entry captures the project memberships Postgres cascade-deletes with
 * this row, so the log preserves which projects the user could access. Nothing is
 * audited for a no-op (already absent), keeping IdP re-syncs quiet.
 *
 * Returns false when the request was rejected and the response is written.
 */
async function deprovisionMembership({
  res,
  user,
  orgId,
  apiKeyId,
}: {
  res: NextApiResponse;
  user: User;
  orgId: string;
  apiKeyId: string;
}): Promise<boolean> {
  const membership = await prisma.organizationMembership.findUnique({
    where: { orgId_userId: { orgId, userId: user.id } },
    include: { ProjectMemberships: true },
  });
  // Already absent: idempotent success, nothing to audit.
  if (!membership) return true;

  if (await rejectIfLastOwner(res, { orgId, userId: user.id, nextRole: null }))
    return false;

  const removed = await prisma.organizationMembership.deleteMany({
    where: { id: membership.id },
  });
  if (removed.count === 0) return true;

  await auditLog({
    apiKeyId,
    orgId,
    resourceType: "orgMembership",
    resourceId: membership.id,
    action: "delete",
    before: membership,
  });
  logger.info(`Deprovisioned user ${user.id} from org ${orgId} via SCIM`);
  return true;
}

/**
 * Apply a display-name update in place. Only `users.name` changes; the account,
 * its memberships, roles and SSO bindings are untouched.
 *
 * There is no uniqueness constraint on names, so this cannot fail - it just
 * skips the write when the value is unchanged.
 */
async function updateUserName({
  user,
  name,
}: {
  user: User;
  name: string;
}): Promise<void> {
  if (name === user.name) return;

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { name },
  });
  // Keep the in-memory copy in sync so the response reports the new name.
  user.name = updated.name;

  logger.info(`Updated name for user ${user.id} to "${name}" via SCIM`);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await runMiddleware(req, res, cors);

  if (!["GET", "DELETE", "PATCH", "PUT"].includes(req.method || "")) {
    logger.error(
      `Method not allowed for ${req.method} on /api/public/scim/Users/[id]`,
    );
    return res.status(405).json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail: "Method not allowed",
      status: 405,
    });
  }

  // CHECK AUTH
  const authCheck = await new ApiAuthService(
    prisma,
    redis,
  ).verifyAuthHeaderAndReturnScope(req.headers.authorization);
  if (!authCheck.validKey) {
    return res.status(401).json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail: authCheck.error,
      status: 401,
    });
  }
  // END CHECK AUTH

  // Check if using an organization API key
  if (
    authCheck.scope.accessLevel !== "organization" ||
    !authCheck.scope.orgId
  ) {
    return res.status(403).json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail:
        "Invalid API key. Organization-scoped API key required for this operation.",
      status: 403,
    });
  }

  logger.info(
    `Received request for /api/public/scim/Users/[id] with method ${req.method} for orgId ${authCheck.scope.orgId} and userId ${req.query.id}`,
  );

  // First, check if the user exists in the system at all
  const user = await prisma.user.findUnique({
    where: {
      id: req.query.id as string,
    },
  });

  if (!user) {
    return res.status(404).json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail: "User not found",
      status: 404,
    });
  }

  // Route to the appropriate handler based on HTTP method
  try {
    switch (req.method) {
      case "PATCH":
        return handlePatch(
          req,
          res,
          user,
          authCheck.scope.orgId,
          authCheck.scope.apiKeyId,
        );
      case "PUT":
        return handlePut(
          req,
          res,
          user,
          authCheck.scope.orgId,
          authCheck.scope.apiKeyId,
        );
      case "GET":
        return handleGet(req, res, user, authCheck.scope.orgId);
      case "DELETE":
        return handleDelete(
          req,
          res,
          user,
          authCheck.scope.orgId,
          authCheck.scope.apiKeyId,
        );
      default:
        // This should never happen due to the check at the beginning
        return res.status(405).json({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          detail: "Method not allowed",
          status: 405,
        });
    }
  } catch (error) {
    logger.error(
      `Error handling SCIM user ${req.query.id} for ${req.method}`,
      error,
    );
    return res.status(500).json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail: "Internal server error",
      status: 500,
    });
  }
}

// GET - Retrieve a specific user
async function handleGet(
  req: NextApiRequest,
  res: NextApiResponse,
  user: User,
  orgId: string,
) {
  // For GET operations, verify the user is a member of the organization
  const orgMembership = await prisma.organizationMembership.findFirst({
    where: {
      orgId: orgId,
      userId: user.id,
    },
  });

  if (!orgMembership) {
    return res.status(404).json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail: "User not found in organization",
      status: 404,
    });
  }

  // Transform to SCIM format
  // With NextJS 15, we can't return NextApiResponse objects anymore
  res
    .status(200)
    .json(toScimUser({ user, role: orgMembership.role, active: true }));
}

/**
 * Respond with the user as it looks *after* the update was applied.
 *
 * Deprovisioning (active=false) removes the organization membership, which makes
 * handleGet answer 404 ("User not found in organization"). Clients such as Okta
 * treat any non-2xx as a FAILED deprovision and will retry / flag the app, even
 * though the change did apply. So look at the actual resulting membership and
 * report it with 200 instead of delegating blindly.
 *
 * Shared by PATCH and PUT so both return the same representation as GET.
 */
async function respondWithResultingUser(
  req: NextApiRequest,
  res: NextApiResponse,
  user: User,
  orgId: string,
) {
  const membership = await prisma.organizationMembership.findFirst({
    where: { orgId: orgId, userId: user.id },
  });

  if (!membership) {
    return res
      .status(200)
      .json(toScimUser({ user, role: null, active: false }));
  }

  // With NextJS 15, we can't return NextApiResponse objects anymore
  return handleGet(req, res, user, orgId);
}

// PATCH - Partial update. Supports replacing `active` (provision/deprovision)
// and `roles` (organization role). Payload example (path-less form, as sent by
// Okta): "{\"schemas\":[\"urn:ietf:params:scim:api:messages:2.0:PatchOp\"],
// \"Operations\":[{\"op\":\"replace\",\"value\":{\"active\":false}}]}"
async function handlePatch(
  req: NextApiRequest,
  res: NextApiResponse,
  user: User,
  orgId: string,
  apiKeyId: string,
) {
  let body = req.body;

  // Check if body is a string and parse it
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (error) {
      logger.warn("Failed to parse JSON body", error);
      return res.status(400).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        detail: "Invalid JSON body",
        status: 400,
      });
    }
  }

  // Validate the request body
  if (
    !body.schemas ||
    !Array.isArray(body.schemas) ||
    !body.schemas.includes("urn:ietf:params:scim:api:messages:2.0:PatchOp")
  ) {
    logger.warn(
      "Invalid request body. Must include 'schemas' with 'urn:ietf:params:scim:api:messages:2.0:PatchOp'.",
      body,
    );
    return res.status(400).json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail:
        "Invalid request body. Must include 'schemas' with 'urn:ietf:params:scim:api:messages:2.0:PatchOp'.",
      status: 400,
    });
  }

  // Check for operations
  if (!body.Operations || !Array.isArray(body.Operations)) {
    logger.warn(
      "Invalid request body. Must include 'Operations' array with at least one operation.",
      body,
    );
    return res.status(400).json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail:
        "Invalid request body. Must include 'Operations' array with at least one operation.",
      status: 400,
    });
  }

  // Process each operation
  for (const op of body.Operations) {
    // RFC 7644 allows two equivalent shapes for a replace operation:
    //   {"op":"replace","path":"active","value":false}   (path form)
    //   {"op":"replace","value":{"active":false}}        (path-less form)
    // Okta sends the path-less form; other clients (e.g. Azure AD) send the
    // path form. Normalize the path form so both are accepted. `path` may carry
    // a value filter, e.g. 'roles[value eq "VIEWER"].value', hence the split.
    let opValue: unknown = op.value;
    let subAttribute: string | undefined;
    if (typeof op.path === "string" && op.path.length > 0) {
      const pathParts = op.path.split(/[.[]/);
      const attribute = pathParts[0]?.trim();
      // e.g. "name.givenName" -> "givenName". Only the name handling uses this.
      subAttribute = pathParts[1]?.trim();
      if (attribute) opValue = { [attribute]: op.value };
    }

    if (op.op === "replace" && opValue && typeof opValue === "object") {
      const value = opValue as {
        active?: unknown;
        roles?: unknown;
        emails?: unknown;
        name?: unknown;
        displayName?: unknown;
      };

      // Display name / name. Unlike the other attributes this never rejects the
      // request: a name we cannot make sense of is skipped with a warning so a
      // combined patch (e.g. name + email) cannot fail as a whole.
      if (value.displayName !== undefined || value.name !== undefined) {
        const requestedName = parseRequestedName({
          displayName: value.displayName,
          name: value.name,
          subAttribute,
          currentName: user.name,
        });
        if (requestedName) {
          await updateUserName({ user, name: requestedName });
        } else {
          logger.warn(
            "Ignoring unsupported name value in SCIM patch",
            JSON.stringify(op),
          );
        }
        continue;
      }

      // Provision / deprovision based on the active flag. PATCH PatchOp values
      // only carry `active` (no roles), so provisioning never changes an
      // existing member's role: it creates a NONE membership when missing and is
      // a no-op otherwise.
      if (typeof value.active === "boolean") {
        if (value.active) {
          if (!(await provisionMembership({ res, user, orgId, apiKeyId })))
            return;
        } else {
          if (!(await deprovisionMembership({ res, user, orgId, apiKeyId })))
            return;
        }
        continue;
      }

      // Update the org role when the patch carries roles. Okta profile/group
      // updates send {"op":"replace","value":{"roles":[...]}} where roles are
      // either plain strings or [{"value":"ADMIN",...}]; the path form sends a
      // single scalar. parseRequestedRole normalizes all of them.
      if (value.roles !== undefined) {
        const requestedRole = parseRequestedRole(value.roles);
        if (requestedRole) {
          if (
            !(await provisionMembership({
              res,
              user,
              orgId,
              apiKeyId,
              role: requestedRole,
            }))
          )
            return;
          continue;
        }
      }
      // `emails` is **read-only**: the address is the identity key of the account
      // (`userName` == `users.email`), so a request that wants to change it means
      // "this is somebody else" and has to go through create/deprovision instead.
      // Accepted as a no-op (200) rather than rejected, so a combined IdP update
      // cannot fail as a whole; the same is true for PUT below.
      if (value.emails !== undefined) {
        logger.info(
          `Ignoring emails update for user ${user.id}: the email address is the account key and is read-only via SCIM`,
        );
        continue;
      }
    }
    logger.error(
      "Unsupported operation or invalid value in request body. Only 'replace' with 'active' / 'roles' / 'emails' / 'name' / 'displayName' fields are supported.",
      op,
    );
    return res.status(400).json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail:
        "Unsupported operation or invalid value in request body. Only 'replace' with 'active' / 'roles' / 'emails' / 'name' / 'displayName' fields are supported.",
      status: 400,
    });
  }
  // Respond with the state that resulted from the patch.
  return respondWithResultingUser(req, res, user, orgId);
}

// PUT - Update user details
async function handlePut(
  req: NextApiRequest,
  res: NextApiResponse,
  user: User,
  orgId: string,
  apiKeyId: string,
) {
  let body = req.body;

  // Check if body is a string and parse it
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (error) {
      logger.warn("Failed to parse JSON body", error);
      return res.status(400).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        detail: "Invalid JSON body",
        status: 400,
      });
    }
  }

  // Validate that it's a SCIM user object
  if (
    !body.schemas ||
    !Array.isArray(body.schemas) ||
    !body.schemas.includes("urn:ietf:params:scim:schemas:core:2.0:User")
  ) {
    logger.warn(
      "Invalid request body. Must include 'schemas' with 'urn:ietf:params:scim:schemas:core:2.0:User'.",
      body,
    );
    return res.status(400).json({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail:
        "Invalid request body. Must include 'schemas' with 'urn:ietf:params:scim:schemas:core:2.0:User'.",
      status: 400,
    });
  }

  // `emails` is read-only on this endpoint too: the address is the account key
  // (`userName` == `users.email`), so it is logged and ignored - a full-resource
  // PUT from an IdP still has to succeed.
  if (body.emails !== undefined) {
    logger.info(
      `Ignoring emails update for user ${user.id}: the email address is the account key and is read-only via SCIM`,
    );
  }

  // Display name / name, same rules as PATCH: `displayName` wins, `name.formatted`
  // is next, given/family are joined as a fallback.
  if (body.displayName !== undefined || body.name !== undefined) {
    const requestedName = parseRequestedName({
      displayName: body.displayName,
      name: body.name,
      currentName: user.name,
    });
    if (requestedName) await updateUserName({ user, name: requestedName });
  }

  // Handle active status for provisioning/deprovisioning
  if (typeof body.active === "boolean") {
    if (body.active) {
      // Determine role from roles if provided; when absent do NOT touch the
      // existing role (a full-resource update must not downgrade an existing
      // member to NONE just because the payload carried no roles).
      // parseRequestedRole accepts the string-array AND the complex
      // [{"value":"ADMIN"}] form that Okta sends.
      const roleWasSupplied =
        body.roles !== undefined &&
        body.roles !== null &&
        (!Array.isArray(body.roles) || body.roles.length > 0);
      const requestedRole = parseRequestedRole(body.roles);
      if (roleWasSupplied && !requestedRole) {
        // Unknown role name: keep the current role rather than failing the whole
        // update, but log it so the misconfigured mapping is visible.
        logger.warn(
          `SCIM PUT for user ${user.id} carried unsupported roles ${JSON.stringify(
            body.roles,
          )}, keeping the current role`,
        );
      }

      // Provision the user, applying the requested role when one was supplied.
      if (
        !(await provisionMembership({
          res,
          user,
          orgId,
          apiKeyId,
          role: requestedRole ?? undefined,
        }))
      )
        return;
    } else {
      // Deprovision the user by removing them from the organization.
      if (!(await deprovisionMembership({ res, user, orgId, apiKeyId })))
        return;
    }
  }

  // PUT applies `displayName` / `name` (in place), `active` and `roles`.
  // `emails` is read-only (ignored above), and `userName` is never read: the
  // account key is `userName` == `users.email`, fixed when the account was
  // created, so this endpoint cannot rename it.

  // Return the resulting state, identical to GET/PATCH. PUT with active=false
  // deprovisions the user; the shared helper then answers 200 with active:false
  // instead of a misleading 404.
  return respondWithResultingUser(req, res, user, orgId);
}

// DELETE - Remove user from organization
async function handleDelete(
  req: NextApiRequest,
  res: NextApiResponse,
  user: User,
  orgId: string,
  apiKeyId: string,
) {
  // Removes the organization membership only; the user row (and therefore their
  // SSO bindings) survives. Refuses to remove the last OWNER.
  if (!(await deprovisionMembership({ res, user, orgId, apiKeyId }))) return;

  // Return empty response with 204 No Content.
  // With NextJS 15, we can't return NextApiResponse objects anymore
  res.status(204).end();
}
