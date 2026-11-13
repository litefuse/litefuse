import { type ApiAccessScope } from "@langfuse/shared/src/server";
import { type NextApiRequest, type NextApiResponse } from "next";

import { requireAdminApiScope } from "@/src/features/public-api/server/adminApiGuard";

/**
 * Enterprise entry point for the organization admin API guard.
 *
 * The checks themselves live in MIT code
 * (`@/src/features/public-api/server/adminApiGuard`) so that a community route
 * can authenticate a request and reject an unavailable operation without loading
 * any licensed module first — see that file for the three checks and the
 * reasoning. This wrapper is kept so the ANNEX A routes keep importing the guard
 * from the enterprise tree.
 */
export async function requireAdminApi(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<ApiAccessScope | null> {
  return requireAdminApiScope(req, res);
}
