import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import { prisma } from "@langfuse/shared/src/db";
import { logger, redis } from "@langfuse/shared/src/server";

import { type NextApiRequest, type NextApiResponse } from "next";
import {
  hashPassword,
  isValidPassword,
} from "@/src/features/auth-credentials/lib/credentialsServerUtils";
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
import { type Role, type User } from "@langfuse/shared/src/db";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await runMiddleware(req, res, cors);

  if (req.method !== "GET" && req.method !== "POST") {
    logger.error(
      `Method not allowed for ${req.method} on /api/public/scim/Users`,
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
      route: "/api/public/scim/Users",
    })
  ) {
    return;
  }

  logger.info(
    `Received request for /api/public/scim/Users with method ${req.method} for orgId ${authCheck.scope.orgId}`,
  );

  if (req.method === "GET") {
    try {
      const { filter, startIndex = 1, count = 100 } = req.query;

      // RFC 7644 3.4.2.4 defines the boundaries of both parameters, and they have
      // to be clamped here instead of being handed to the database:
      // - `startIndex` is 1-based and a value below 1 is interpreted as 1. The
      //   previous `parseInt(...) || 1` could not do that - `-1` is truthy, so it
      //   survived and produced `skip: -2`, which made Prisma throw and turned a
      //   paginated request into a 500.
      // - `count` is non-negative and a negative value is interpreted as 0. A
      //   negative `take` additionally means "take from the end" in Prisma, so it
      //   silently returned the last page instead of an empty one.
      // - `count: 0` returns no resources while still reporting `totalResults`.
      // A value that is not a number at all falls back to the defaults.
      const requestedStartIndex = parseInt(startIndex as string, 10);
      const parsedStartIndex = Number.isNaN(requestedStartIndex)
        ? 1
        : Math.max(1, requestedStartIndex);
      const requestedCount = parseInt(count as string, 10);
      const parsedCount = Number.isNaN(requestedCount)
        ? 100
        : Math.max(0, requestedCount);

      let whereClause = {};
      if (filter && typeof filter === "string") {
        // Identity lookups first: `externalId` / `id` both address the account by
        // our internal id, which is what a client uses once it holds the link.
        const externalIdMatch = filter.match(/externalId eq "([^"]+)"/i);
        const idMatch = filter.match(/\bid eq "([^"]+)"/i);
        // `userName eq "value"` is the RFC 7643 lookup (and the account key).
        const userNameMatch = filter.match(/userName eq "([^"]+)"/i);

        if (externalIdMatch && externalIdMatch[1]) {
          whereClause = { ...whereClause, id: externalIdMatch[1] };
        } else if (idMatch && idMatch[1]) {
          whereClause = { ...whereClause, id: idMatch[1] };
        } else if (userNameMatch && userNameMatch[1]) {
          whereClause = {
            ...whereClause,
            email: userNameMatch[1].toLowerCase(),
          };
        }
      }

      // Get total count for pagination
      const totalCount = await prisma.organizationMembership.count({
        where: {
          user: whereClause,
          orgId: authCheck.scope.orgId,
        },
      });

      // Get users with pagination
      const userMapping = await prisma.organizationMembership.findMany({
        where: {
          user: whereClause,
          orgId: authCheck.scope.orgId,
        },
        skip: parsedStartIndex - 1, // SCIM uses 1-based indexing
        take: parsedCount,
        select: {
          id: true,
          role: true,
          // `updatedAt` feeds `meta.lastModified`: a role change only touches this
          // row, so the account timestamp alone would look unmodified.
          updatedAt: true,
          user: true,
        },
      });

      // Transform to SCIM format. The membership role is the source of truth:
      // every listed user is by definition an active member of this org.
      const scimUsers = userMapping.map((userMap) =>
        toScimUser({
          user: userMap.user,
          role: userMap.role,
          active: true,
          membershipUpdatedAt: userMap.updatedAt,
        }),
      );

      return res.status(200).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: totalCount,
        startIndex: parsedStartIndex,
        itemsPerPage: scimUsers.length,
        Resources: scimUsers,
      });
    } catch (error) {
      logger.error("Error retrieving SCIM users", error);
      return res.status(500).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        detail: "Internal server error",
        status: 500,
      });
    }
  }

  if (req.method === "POST") {
    try {
      let body = req.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch (error) {
          logger.error("Failed to parse JSON body", error);
          return res.status(400).json({
            schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
            detail: "Invalid JSON body",
            status: 400,
          });
        }
      }

      const { userName, name, password, displayName, roles, externalId } = body;

      if (!userName || typeof userName !== "string") {
        logger.warn("userName is required for SCIM user creation", body);
        return res.status(400).json({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          detail: "userName is required",
          status: 400,
        });
      }

      // Emails are stored lowercased (see users.email), so every lookup has to be
      // normalized as well - otherwise "Alice@x.com" would slip past the
      // duplicate check and then violate the (orgId, userId) unique constraint.
      const normalizedUserName = userName.toLowerCase();

      // Okta sends roles as [{"value":"ADMIN"}], other clients as ["ADMIN"].
      // Omitting `roles` keeps the NONE default (a create that maps no role must
      // still succeed), an unknown role name is rejected so a misconfigured
      // mapping does not silently become NONE, and a value that is present but
      // empty is rejected too - see EMPTY_ROLES_DETAIL.
      let role: Role = "NONE";
      if (roles !== undefined && isEmptyRoleValue(roles)) {
        logger.warn("Empty roles provided for SCIM user creation", roles);
        return res
          .status(400)
          .json(scimErrorBody(400, EMPTY_ROLES_DETAIL));
      }
      if (roles && Array.isArray(roles) && roles.length > 0) {
        const requestedRole = parseRequestedRole(roles);
        if (!requestedRole) {
          logger.warn("Invalid roles provided for SCIM user creation", roles);
          return res
            .status(400)
            .json(
              scimErrorBody(
                400,
                `Invalid roles provided: ${JSON.stringify(roles)}, must be one of OWNER, ADMIN, MEMBER, VIEWER, NONE`,
              ),
            );
        }
        role = requestedRole;
      }

      // `password` is optional and only ever written for a newly created account.
      // It is the only credential SCIM can set, so it has to satisfy the platform
      // minimum - the same `isValidPassword` the sign-up and password-reset paths
      // enforce through `createUserEmailPassword` / `updateUserPassword`. A value
      // that fails it rejects the whole create before anything is written, so a
      // rejected request never leaves a half-created account behind.
      let passwordToStore: string | null = null;
      if (password !== undefined && password !== null && password !== "") {
        if (typeof password !== "string" || !isValidPassword(password)) {
          logger.warn("Invalid password provided for SCIM user creation");
          return res
            .status(400)
            .json(
              scimErrorBody(
                400,
                "Invalid password: must be a string of at least 8 characters",
              ),
            );
        }
        passwordToStore = password;
      }

      // Resolve the target account. `externalId` comes first - it is the id we
      // handed out in an earlier response, so a client that keeps its own link
      // identifies the account directly instead of by `userName`. `userName`
      // (== users.email, the RFC 7643 uniqueness key) is the fallback and the
      // only source of the email address.
      const userByExternalId =
        typeof externalId === "string" && externalId.trim().length > 0
          ? await prisma.user.findUnique({ where: { id: externalId.trim() } })
          : null;
      const userByUserName = await prisma.user.findUnique({
        where: { email: normalizedUserName },
      });

      // `externalId` says one account, `userName` belongs to another: the request
      // contradicts itself, nothing is written (the email is the account key and
      // cannot be moved between accounts).
      if (
        userByExternalId &&
        userByUserName &&
        userByExternalId.id !== userByUserName.id
      ) {
        logger.warn(
          `SCIM create: externalId ${externalId} and userName ${userName} point at different users`,
        );
        return res.status(409).json({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          detail: "externalId and userName refer to different users",
          status: 409,
        });
      }

      // The user row is global (users.email is unique across the instance), so a
      // userName that already exists in *another* organization is reused as-is:
      // the email, the password and the SSO bindings are never overwritten, the
      // user is simply added to this organization below. Only a user who is
      // *already a member of this organization* is a duplicate (checked next).
      //
      // Display name resolution matches PATCH/PUT: `displayName` wins, then
      // `name.formatted`, then given/family joined together. It is only applied
      // to an existing account when the request actually carries a name.
      const requestedName = parseRequestedName({ displayName, name });
      const existingUser = userByExternalId ?? userByUserName;

      // A duplicate is "this account is already a member of this organization",
      // and it is rejected without executing anything: the check runs before the
      // first write, so a repeated create cannot touch the account (name, email),
      // the membership or its role. Role changes belong to PATCH/PUT, which is
      // where the last-OWNER guard lives - a create must never be able to bypass
      // it. Matches upstream Langfuse (`User with this userName already exists`).
      if (existingUser) {
        const existingMembership =
          await prisma.organizationMembership.findUnique({
            where: {
              orgId_userId: {
                orgId: authCheck.scope.orgId,
                userId: existingUser.id,
              },
            },
          });
        if (existingMembership) {
          logger.warn(
            `SCIM create: user ${existingUser.id} (${existingUser.email}) already exists in org ${authCheck.scope.orgId}`,
          );
          return res.status(409).json({
            schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
            detail: "User with this userName already exists",
            status: 409,
          });
        }
      }

      if (existingUser && existingUser.email !== normalizedUserName) {
        logger.warn(
          `SCIM create: user ${existingUser.id} identified by externalId has userName ${existingUser.email}, request asked for ${normalizedUserName} (email is not changed)`,
        );
      }

      let user: User;
      if (existingUser) {
        user =
          requestedName && requestedName !== existingUser.name
            ? await prisma.user.update({
                where: { id: existingUser.id },
                data: { name: requestedName },
              })
            : existingUser;
        logger.info(
          `SCIM create resolved to existing user ${user.id} (${user.email}) for org ${authCheck.scope.orgId}`,
        );
      } else {
        user = await prisma.user.create({
          data: {
            email: normalizedUserName,
            name: requestedName ?? undefined,
            password: passwordToStore
              ? await hashPassword(passwordToStore)
              : undefined,
          },
        });
      }

      // The duplicate check above already guaranteed that this organization does
      // not have this user yet, so the membership is always created here. The
      // membership is the "active" flag.
      const orgMembership = await prisma.organizationMembership.create({
        data: {
          userId: user.id,
          orgId: authCheck.scope.orgId,
          role,
        },
      });
      await auditLog({
        apiKeyId: authCheck.scope.apiKeyId,
        orgId: authCheck.scope.orgId,
        resourceType: "orgMembership",
        resourceId: orgMembership.id,
        action: "create",
        after: orgMembership,
      });
      logger.info(
        `Assigned user ${user.id} to org ${authCheck.scope.orgId} with role ${role}`,
      );

      // Return the created resource in the same representation as GET/PATCH/PUT.
      return res.status(201).json(
        toScimUser({
          user,
          role,
          active: true,
          membershipUpdatedAt: orgMembership.updatedAt,
        }),
      );
    } catch (error) {
      logger.error("Failed to create SCIM user", error);
      return res.status(500).json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        detail: "Internal server error",
        status: 500,
      });
    }
  }
}
