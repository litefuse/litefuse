import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import {
  USER_RESOURCE_TYPE_ID,
  userResourceType,
  writeNotFound,
} from "@/src/features/public-api/server/scimDiscovery";
import { prisma } from "@langfuse/shared/src/db";
import { logger, redis } from "@langfuse/shared/src/server";

import { type NextApiRequest, type NextApiResponse } from "next";

/**
 * `GET /api/public/scim/ResourceTypes/{id}` - one resource type on its own.
 *
 * `/ResourceTypes` advertises this path as the `meta.location` of every entry it
 * returns, and RFC 7644 section 3.4.1 lists it among the ways to retrieve a
 * known resource, so a client that follows the location has to get the
 * declaration rather than a 404. The body is exactly the entry the collection
 * returns, so the two can never disagree.
 *
 * Authentication is the discovery one (organization-scoped key, no plan gate):
 * this endpoint declares capabilities, it does not touch memberships.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await runMiddleware(req, res, cors);

  if (req.method !== "GET") {
    logger.error(
      `Method not allowed for ${req.method} on /api/public/scim/ResourceTypes/[id]`,
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

  const id = typeof req.query.id === "string" ? req.query.id : "";
  // Resource type ids are registered names; compare case-insensitively so a
  // client that lowercases the path segment still finds "User".
  if (id.toLowerCase() !== USER_RESOURCE_TYPE_ID.toLowerCase()) {
    logger.warn(`SCIM resource type not found: ${id}`);
    return writeNotFound(res, `ResourceType ${id} not found`);
  }

  return res.status(200).json(userResourceType());
}
