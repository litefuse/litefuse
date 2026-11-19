import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import {
  EMPTY_ROLES_DETAIL,
  isEmptyRoleValue,
  parseRequestedName,
  parseRequestedRole,
  scimErrorBody,
  toScimUser,
} from "@/src/features/public-api/server/scimUser";
import { rejectUnlessScimIsEntitled } from "@/src/features/public-api/server/scimAccess";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import {
  prisma,
  type Prisma,
  type Role,
  type User,
} from "@langfuse/shared/src/db";
import { logger, redis } from "@langfuse/shared/src/server";
import { type NextApiRequest, type NextApiResponse } from "next";

const LAST_OWNER_MESSAGE =
  "Cannot remove the last owner of an organization. Assign new owner or delete organization.";

const UNSUPPORTED_OPERATION_MESSAGE =
  "Unsupported operation or invalid value in request body. Only 'replace' with 'active' / 'roles' / 'emails' / 'name' / 'displayName' fields are supported.";

/** The Prisma client a request's writes run on - a transaction while applying. */
type Db = Prisma.TransactionClient;

/**
 * A rejection that has to abort the whole write path.
 *
 * It is *thrown* rather than written to the response so it can travel out of the
 * Prisma transaction that applies a request: the transaction then rolls back
 * every statement of that request and the caller renders the response. That is
 * what makes a multi-operation PATCH all-or-nothing - a rejected operation may
 * not leave the earlier ones applied.
 */
class ScimWriteRejected extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "ScimWriteRejected";
  }
}

/**
 * Map a rejection thrown inside a transaction to its SCIM response, or `null`
 * when the error is not one of ours (i.e. it should keep propagating).
 */
function asScimRejection(
  error: unknown,
): { status: number; detail: string } | null {
  return error instanceof ScimWriteRejected
    ? { status: error.status, detail: error.detail }
    : null;
}

/** 400 for an operation that carries no attribute we understand. */
function writeUnsupportedOperation(res: NextApiResponse, op: unknown) {
  logger.error(UNSUPPORTED_OPERATION_MESSAGE, op);
  return res
    .status(400)
    .json(scimErrorBody(400, UNSUPPORTED_OPERATION_MESSAGE));
}

/**
 * 400 for an `active` that is present but not a boolean (`"false"`, `0`, `{}`…).
 * `null` is treated as "no value" and never reaches this.
 */
function writeInvalidActive(res: NextApiResponse, active: unknown) {
  const detail = `Invalid value for active: ${JSON.stringify(active)}, must be a boolean`;
  logger.warn(`SCIM patch: ${detail}`);
  return res.status(400).json(scimErrorBody(400, detail));
}

/**
 * 400 for a `roles` value that is present and non-empty but cannot be resolved to
 * a role.
 */
function writeInvalidRoles(res: NextApiResponse, roles: unknown) {
  const detail = `Invalid roles provided: ${JSON.stringify(roles)}, must be one of OWNER, ADMIN, MEMBER, VIEWER, NONE`;
  logger.warn(`SCIM patch: ${detail}`);
  return res.status(400).json(scimErrorBody(400, detail));
}

/**
 * 400 for a `roles` value that is present but carries nothing (`[]`, `null`,
 * `""`, `[{"value":""}]`, `[null]`). Rejecting it rather than ignoring it is
 * deliberate: the request said something about the role and we cannot tell what
 * it meant, so guessing would either hide a misconfigured mapping (ignore) or
 * silently drop a member's permissions (`NONE`). `NONE` itself stays a valid,
 * explicit value.
 */
function writeEmptyRoles(res: NextApiResponse, roles: unknown) {
  logger.warn(
    `SCIM write refused: empty roles value ${JSON.stringify(roles)} on /api/public/scim/Users/[id]`,
  );
  return res.status(400).json(scimErrorBody(400, EMPTY_ROLES_DETAIL));
}

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
 * Throws `ScimWriteRejected` (403) instead of writing the response, so the
 * enclosing transaction rolls back before the caller answers.
 */
async function rejectIfLastOwner(
  tx: Db,
  {
    orgId,
    userId,
    nextRole,
  }: {
    orgId: string;
    userId: string;
    nextRole: Role | null | undefined;
  },
): Promise<void> {
  if (nextRole === undefined || nextRole === "OWNER") return;

  const membership = await tx.organizationMembership.findUnique({
    where: { orgId_userId: { orgId, userId } },
  });
  if (membership?.role !== "OWNER") return;

  const owners = await tx.organizationMembership.count({
    where: { orgId, role: "OWNER" },
  });
  if (owners > 1) return;

  logger.warn(
    `Refused to remove last OWNER ${userId} from org ${orgId} via SCIM`,
  );
  throw new ScimWriteRejected(403, LAST_OWNER_MESSAGE);
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
 * that re-sends the same payload does not flood the audit log. It is written on
 * the same client as the membership, so it commits or rolls back with it.
 */
async function provisionMembership(
  tx: Db,
  {
    user,
    orgId,
    apiKeyId,
    role,
  }: {
    user: User;
    orgId: string;
    apiKeyId: string;
    role?: Role;
  },
): Promise<void> {
  const existing = await tx.organizationMembership.findUnique({
    where: { orgId_userId: { orgId, userId: user.id } },
  });

  if (existing) {
    if (role === undefined || existing.role === role) return;

    await rejectIfLastOwner(tx, { orgId, userId: user.id, nextRole: role });

    const updated = await tx.organizationMembership.update({
      where: { orgId_userId: { orgId, userId: user.id } },
      data: { role },
    });
    await auditLog(
      {
        apiKeyId,
        orgId,
        resourceType: "orgMembership",
        resourceId: updated.id,
        action: "update",
        before: existing,
        after: updated,
      },
      tx,
    );
    logger.info(
      `Updated role for user ${user.id} in org ${orgId} to ${role} via SCIM`,
    );
    return;
  }

  const created = await tx.organizationMembership.create({
    data: { userId: user.id, orgId, role: role ?? "NONE" },
  });
  await auditLog(
    {
      apiKeyId,
      orgId,
      resourceType: "orgMembership",
      resourceId: created.id,
      action: "create",
      after: created,
    },
    tx,
  );
  logger.info(
    `Provisioned user ${user.id} in org ${orgId} with role ${created.role} via SCIM`,
  );
}

/**
 * Deprovision a user (SCIM `active: false` or DELETE): removes the organization
 * membership, refusing to remove the last OWNER.
 *
 * The audit entry captures the project memberships Postgres cascade-deletes with
 * this row, so the log preserves which projects the user could access. Nothing is
 * audited for a no-op (already absent), keeping IdP re-syncs quiet.
 */
async function deprovisionMembership(
  tx: Db,
  {
    user,
    orgId,
    apiKeyId,
  }: {
    user: User;
    orgId: string;
    apiKeyId: string;
  },
): Promise<void> {
  const membership = await tx.organizationMembership.findUnique({
    where: { orgId_userId: { orgId, userId: user.id } },
    include: { ProjectMemberships: true },
  });
  // Already absent: idempotent success, nothing to audit.
  if (!membership) return;

  await rejectIfLastOwner(tx, { orgId, userId: user.id, nextRole: null });

  const removed = await tx.organizationMembership.deleteMany({
    where: { id: membership.id },
  });
  if (removed.count === 0) return;

  await auditLog(
    {
      apiKeyId,
      orgId,
      resourceType: "orgMembership",
      resourceId: membership.id,
      action: "delete",
      before: membership,
    },
    tx,
  );
  logger.info(`Deprovisioned user ${user.id} from org ${orgId} via SCIM`);
}

/**
 * Apply a display-name update in place. Only `users.name` changes; the account,
 * its memberships, roles and SSO bindings are untouched.
 *
 * There is no uniqueness constraint on names, so this cannot fail - it just
 * skips the write when the value is unchanged.
 */
async function updateUserName(
  tx: Db,
  {
    user,
    name,
  }: {
    user: User;
    name: string;
  },
): Promise<void> {
  if (name === user.name) return;

  const updated = await tx.user.update({
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

  // SCIM provisioning is an organization administration capability, so it needs
  // the same `admin-api` entitlement as the other org admin endpoints.
  if (
    rejectUnlessScimIsEntitled({
      res,
      plan: authCheck.scope.plan,
      route: "/api/public/scim/Users/[id]",
    })
  ) {
    return;
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

  // Re-read the account before rendering it: PATCH and PUT answer through this
  // handler, and by then the row they loaded at request start is stale - the
  // name write (and with it `updatedAt`, which drives `meta.lastModified`) has
  // already happened. Reporting the pre-write copy would tell a syncing client
  // that nothing changed.
  const current =
    (await prisma.user.findUnique({ where: { id: user.id } })) ?? user;

  // Transform to SCIM format
  // With NextJS 15, we can't return NextApiResponse objects anymore
  res.status(200).json(
    toScimUser({
      user: current,
      role: orgMembership.role,
      active: true,
      // `roles`/`active` live on the membership, whose `updatedAt` moves on every
      // role change even though the account row is not touched.
      membershipUpdatedAt: orgMembership.updatedAt,
    }),
  );
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
  /**
   * Set when this request removed the membership (`active: false`). The row is
   * gone by now, so its `updatedAt` cannot be read back - the removal itself is
   * the last modification of the resource.
   */
  membershipRemovedAt?: Date,
) {
  const membership = await prisma.organizationMembership.findFirst({
    where: { orgId: orgId, userId: user.id },
  });

  if (!membership) {
    const current =
      (await prisma.user.findUnique({ where: { id: user.id } })) ?? user;
    return res.status(200).json(
      toScimUser({
        user: current,
        role: null,
        active: false,
        membershipUpdatedAt: membershipRemovedAt,
      }),
    );
  }

  // With NextJS 15, we can't return NextApiResponse objects anymore
  return handleGet(req, res, user, orgId);
}

// PATCH - Partial update. Supports replacing `active` (provision/deprovision),
// `roles` (organization role) and the name. Payload example (path-less form, as
// sent by Okta): "{\"schemas\":[\"urn:ietf:params:scim:api:messages:2.0:PatchOp\"],
// \"Operations\":[{\"op\":\"replace\",\"value\":{\"active\":false}}]}"
//
// A `roles` value that is present but empty (`[]`, `null`, `""`, `[null]`) is
// refused (400) and rolls the whole request back. `NONE` is a valid role, so
// "remove all permissions but stay a member" is `roles: ["NONE"]`.
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

  // ---- phase 1: resolve and validate every operation, without writing ----
  //
  // A PATCH is applied atomically: all operations are validated first and only
  // then applied inside a single transaction. So an invalid operation aborts the
  // whole request and writes nothing at all - a rejected operation must not leave
  // the earlier ones applied.
  //
  // Empty values are *not* invalid: `roles: []` / `null` / `""` and `active: null`
  // mean "leave this attribute alone" and simply change nothing.
  type ResolvedOperation = {
    op: unknown;
    nameRequested: boolean;
    requestedName: string | null;
    membershipChange: boolean | undefined; // true = provision, false = deprovision
    requestedRole: Role | null;
    emailsPresent: boolean;
  };
  const resolved: ResolvedOperation[] = [];
  // A name sub-path (`name.givenName`) merges with the name that is in effect when
  // that operation is applied, so the projection has to follow the operations in
  // order instead of always reading the stored name.
  let projectedName = user.name;

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

    if (!(op.op === "replace" && opValue && typeof opValue === "object")) {
      return writeUnsupportedOperation(res, op);
    }

    const value = opValue as {
      active?: unknown;
      roles?: unknown;
      emails?: unknown;
      name?: unknown;
      displayName?: unknown;
    };

    // RFC 7644 lets an operation's `value` be a partial resource, so a single
    // operation may legitimately carry several attributes at once, e.g.
    // {"active":true,"roles":["ADMIN"]} or a combined name + role update.
    // **Every attribute present is applied.** An earlier version used an ordered
    // if-chain with a `continue` in each branch, which silently dropped every
    // attribute after the first match.
    let nameRequested = false;
    let requestedName: string | null = null;
    let membershipChange: boolean | undefined; // true = provision, false = deprovision
    let requestedRole: Role | null = null;
    const activePresent = value.active !== undefined;
    const rolesPresent = value.roles !== undefined;

    // A `roles` value that is present but carries nothing is refused, and because
    // this runs in the validation phase nothing is written: the whole PATCH is
    // rejected. `NONE` is a real role, so "no permission" has to be asked for
    // explicitly with `["NONE"]` - an empty value is a request we cannot act on.
    if (rolesPresent && isEmptyRoleValue(value.roles)) {
      return writeEmptyRoles(res, value.roles);
    }
    const hasRoleValue = rolesPresent;

    // Display name / name. Unlike the other attributes this never rejects the
    // request: an empty or unparsable name is skipped with a warning, so a
    // combined patch cannot fail as a whole.
    if (value.displayName !== undefined || value.name !== undefined) {
      nameRequested = true;
      requestedName = parseRequestedName({
        displayName: value.displayName,
        name: value.name,
        subAttribute,
        currentName: projectedName,
      });
      if (requestedName) projectedName = requestedName;
    }

    if (typeof value.active === "boolean") {
      membershipChange = value.active;
      // Activating together with a role is applied in one write instead of
      // creating a NONE membership and updating it right after.
      if (value.active && hasRoleValue) {
        requestedRole = parseRequestedRole(value.roles);
        if (!requestedRole) return writeInvalidRoles(res, value.roles);
      }
      // `active:false` deletes the membership, so a role in the same operation
      // has nothing left to apply to - `active` wins.
    } else if (activePresent && value.active !== null) {
      // `null` means "no value", i.e. leave the membership alone; any other
      // non-boolean is a type error. Ignoring it silently would answer 200 for a
      // request that meant to deactivate somebody, which is the one failure mode
      // that must stay visible.
      return writeInvalidActive(res, value.active);
    } else if (hasRoleValue) {
      // Roles without `active`: a role only exists on a membership, so this
      // provisions the user like `active:true` would.
      membershipChange = true;
      requestedRole = parseRequestedRole(value.roles);
      if (!requestedRole) return writeInvalidRoles(res, value.roles);
    }

    // An operation is rejected only when it carries no attribute we know at all.
    // An attribute that is present but empty (`roles: []`, `active: null`) counts
    // as recognised and simply changes nothing.
    if (
      !nameRequested &&
      !activePresent &&
      !rolesPresent &&
      value.emails === undefined
    ) {
      return writeUnsupportedOperation(res, op);
    }

    resolved.push({
      op,
      nameRequested,
      requestedName,
      membershipChange,
      requestedRole,
      emailsPresent: value.emails !== undefined,
    });
  }

  // ---- phase 2: apply every operation in one transaction ----
  //
  // Order within an operation is membership → name → emails: the membership is the
  // only step that can still be rejected while applying (last-OWNER protection),
  // and that rejection must not leave a name update behind. Everything the request
  // writes - memberships, the name and the audit entries - commits or rolls back
  // as one.
  // Deprovisioning deletes the membership row, so the moment it happened is only
  // known here - the response reports it as `meta.lastModified`.
  let membershipRemovedAt: Date | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      for (const step of resolved) {
        if (step.membershipChange === true) {
          await provisionMembership(tx, {
            user,
            orgId,
            apiKeyId,
            role: step.requestedRole ?? undefined,
          });
        } else if (step.membershipChange === false) {
          await deprovisionMembership(tx, { user, orgId, apiKeyId });
          membershipRemovedAt = new Date();
        }

        if (step.nameRequested) {
          if (step.requestedName) {
            await updateUserName(tx, { user, name: step.requestedName });
          } else {
            logger.warn(
              "Ignoring empty or unsupported name value in SCIM patch",
              JSON.stringify(step.op),
            );
          }
        }

        // `emails` is **read-only**: the address is the identity key of the account
        // (`userName` == `users.email`), so a request that wants to change it means
        // "this is somebody else" and has to go through create/deprovision instead.
        // Accepted as a no-op (200) rather than rejected, so a combined IdP update
        // cannot fail as a whole; the same is true for PUT below.
        if (step.emailsPresent) {
          logger.info(
            `Ignoring emails update for user ${user.id}: the email address is the account key and is read-only via SCIM`,
          );
        }
      }
    });
  } catch (error) {
    // The transaction has rolled back; render the rejection it aborted with.
    const rejection = asScimRejection(error);
    if (!rejection) throw error;
    return res
      .status(rejection.status)
      .json(scimErrorBody(rejection.status, rejection.detail));
  }

  // Respond with the state that resulted from the patch.
  return respondWithResultingUser(req, res, user, orgId, membershipRemovedAt);
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

  // Everything this request writes goes into one transaction, so a rejected
  // membership change (last-OWNER protection) cannot leave a name update behind.
  //
  // The request is resolved before anything is written: an `active` that is not a
  // boolean leaves the membership alone, a `roles` value that is present but empty
  // rejects the whole update, and one that is present but cannot be resolved to a
  // role rejects it as well - neither is logged and ignored any more. POST and
  // PATCH answer 400 for both cases; PUT does too.
  //
  // `roles` being *absent* still means "leave the role alone": a full-resource
  // update must not downgrade a member to NONE just because the IdP payload
  // carries no roles.
  if (body.roles !== undefined && isEmptyRoleValue(body.roles)) {
    return writeEmptyRoles(res, body.roles);
  }

  const requestedName =
    body.displayName !== undefined || body.name !== undefined
      ? parseRequestedName({
          displayName: body.displayName,
          name: body.name,
          currentName: user.name,
        })
      : null;

  const activeSupplied = typeof body.active === "boolean";
  let requestedRole: Role | null = null;
  if (activeSupplied && body.active && body.roles !== undefined) {
    // `parseRequestedRole` accepts the string-array AND the complex
    // [{"value":"ADMIN"}] form that Okta sends.
    requestedRole = parseRequestedRole(body.roles);
    if (!requestedRole) return writeInvalidRoles(res, body.roles);
  }

  // Deprovisioning deletes the membership row, so the moment it happened is only
  // known here - the response reports it as `meta.lastModified`.
  let membershipRemovedAt: Date | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      if (requestedName) {
        await updateUserName(tx, { user, name: requestedName });
      }

      if (activeSupplied) {
        if (body.active) {
          // Provision the user, applying the requested role when one was supplied.
          await provisionMembership(tx, {
            user,
            orgId,
            apiKeyId,
            role: requestedRole ?? undefined,
          });
        } else {
          // Deprovision the user by removing them from the organization.
          await deprovisionMembership(tx, { user, orgId, apiKeyId });
          membershipRemovedAt = new Date();
        }
      }
    });
  } catch (error) {
    // The transaction has rolled back; render the rejection it aborted with.
    const rejection = asScimRejection(error);
    if (!rejection) throw error;
    return res
      .status(rejection.status)
      .json(scimErrorBody(rejection.status, rejection.detail));
  }

  // PUT applies `displayName` / `name` (in place), `active` and `roles`.
  // `emails` is read-only (ignored above), and `userName` is never read: the
  // account key is `userName` == `users.email`, fixed when the account was
  // created, so this endpoint cannot rename it.

  // Return the resulting state, identical to GET/PATCH. PUT with active=false
  // deprovisions the user; the shared helper then answers 200 with active:false
  // instead of a misleading 404.
  return respondWithResultingUser(req, res, user, orgId, membershipRemovedAt);
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
  //
  // A delete carries a single piece of information rather than a set of
  // attributes, so there is nothing to roll back and it stays outside a
  // transaction: the membership and its audit entry are written as before.
  try {
    await deprovisionMembership(prisma, { user, orgId, apiKeyId });
  } catch (error) {
    const rejection = asScimRejection(error);
    if (!rejection) throw error;
    return res
      .status(rejection.status)
      .json(scimErrorBody(rejection.status, rejection.detail));
  }

  // Return empty response with 204 No Content.
  // With NextJS 15, we can't return NextApiResponse objects anymore
  res.status(204).end();
}
