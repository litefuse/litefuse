import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import {
  USER_SCHEMA_URN,
  userSchemaDeclaration,
  writeNotFound,
} from "@/src/features/public-api/server/scimDiscovery";
import { prisma } from "@langfuse/shared/src/db";
import { logger, redis } from "@langfuse/shared/src/server";

import { type NextApiRequest, type NextApiResponse } from "next";

/**
 * `GET /api/public/scim/Schemas/{urn}` - one schema on its own.
 *
 * `/Schemas` advertises this path as the `meta.location` of every entry it
 * returns, so it has to answer with the same declaration. The `{urn}` segment
 * carries colons (`urn:ietf:params:scim:schemas:core:2.0:User`), which are legal
 * in a path segment; Next.js hands the parameter over already percent-decoded,
 * so a client may send either form.
 *
 * Authentication is the discovery one (organization-scoped key, no plan gate).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await runMiddleware(req, res, cors);

  if (req.method !== "GET") {
    logger.error(
      `Method not allowed for ${req.method} on /api/public/scim/Schemas/[id]`,
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
  // Only the one schema this service declares is addressable. The value in the
  // path is the schema's `id`, i.e. its URN, so it is compared verbatim (a URN's
  // URN-specific string is case sensitive).
  if (id !== USER_SCHEMA_URN) {
    logger.warn(`SCIM schema not found: ${id}`);
    return writeNotFound(res, `Schema ${id} not found`);
  }

  return res.status(200).json(userSchemaDeclaration());
}
