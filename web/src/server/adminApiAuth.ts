import { timingSafeEqual } from "crypto";
import { type NextApiRequest, type NextApiResponse } from "next";

import { env } from "@/src/env.mjs";
import { logger } from "@langfuse/shared/src/server";

export interface AdminAuthResult {
  isAuthorized: boolean;
  error?: string;
}

export interface AdminAuthOptions {
  isAllowedOnLangfuseCloud?: boolean;
}

/**
 * Credential problems are phrased with this word, which is how the guard below
 * tells a 401 apart from the instance-side refusals that answer 403.
 */
const UNAUTHORIZED_PREFIX = "Unauthorized";

/** Answer for a request that carries no authorization header at all. */
const MISSING_AUTHORIZATION_ERROR =
  "Unauthorized: authorization header is missing";

/**
 * Constant-time comparison of the provided token with the configured key.
 * `timingSafeEqual` throws on buffers of unequal length, hence the length check
 * up front.
 */
const tokenMatchesAdminKey = (token: string, adminKey: string): boolean => {
  const provided = Buffer.from(token);
  const configured = Buffer.from(adminKey);
  if (provided.length !== configured.length) {
    return false;
  }
  return timingSafeEqual(provided, configured);
};

export class AdminApiAuthService {
  static verifyAdminAuthFromAuthString(
    authString: string,
    options: AdminAuthOptions = {},
  ): AdminAuthResult {
    const allowOnLitefuseCloud = options.isAllowedOnLangfuseCloud ?? false;

    // Admin endpoints stay closed on Litefuse Cloud unless they opt in. The
    // "DEV" region covers local runs and CI.
    const cloudRegion = env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION;
    if (!allowOnLitefuseCloud && cloudRegion && cloudRegion !== "DEV") {
      return {
        isAuthorized: false,
        error: "Not accessible on Litefuse Cloud",
      };
    }

    const adminApiKey = env.ADMIN_API_KEY;
    if (!adminApiKey) {
      logger.error("Rejected admin API request: no ADMIN_API_KEY configured");
      return {
        isAuthorized: false,
        error: "ADMIN_API_KEY is not set",
      };
    }

    const authParts = authString.split(" ");
    const scheme = authParts[0];
    const token = authParts[1];
    if (
      scheme !== "Bearer" ||
      !token ||
      !tokenMatchesAdminKey(token, adminApiKey)
    ) {
      return {
        isAuthorized: false,
        error: "Unauthorized: Invalid token",
      };
    }

    return {
      isAuthorized: true,
    };
  }

  /**
   * Middleware guard for admin API routes: authenticates the request and, when
   * it fails, writes the error response itself.
   *
   * @param options Admin auth options. Access stays blocked on Litefuse Cloud
   * unless `isAllowedOnLangfuseCloud` is set.
   * @returns true when the caller may proceed, false once a response was sent.
   */
  public static handleAdminAuth(
    req: NextApiRequest,
    res: NextApiResponse,
    options: AdminAuthOptions = {},
  ): boolean {
    const { authorization } = req.headers;
    if (!authorization) {
      res.status(401).json({ error: MISSING_AUTHORIZATION_ERROR });
      return false;
    }

    const outcome = AdminApiAuthService.verifyAdminAuthFromAuthString(
      authorization,
      options,
    );

    if (outcome.isAuthorized) {
      return true;
    }

    const status = outcome.error?.startsWith(UNAUTHORIZED_PREFIX) ? 401 : 403;
    res.status(status).json({ error: outcome.error });
    return false;
  }
}
