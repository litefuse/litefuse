import { timingSafeEqual } from "crypto";
import { type IncomingHttpHeaders } from "http";
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
 * Constant-time comparison of the provided token against the expected key.
 * Compares byte lengths first since `timingSafeEqual` throws on unequal
 * buffer lengths.
 */
const isTokenValid = (token: string, expectedKey: string): boolean => {
  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expectedKey);
  if (tokenBuffer.byteLength !== expectedBuffer.byteLength) {
    return false;
  }
  return timingSafeEqual(tokenBuffer, expectedBuffer);
};

export class AdminApiAuthService {
  static verifyAdminAuthFromAuthString = (
    authString: string,
    options: AdminAuthOptions = {},
  ): AdminAuthResult => {
    const { isAllowedOnLangfuseCloud = false } = options;

    // Block access on Litefuse Cloud unless explicitly allowed
    if (
      !isAllowedOnLangfuseCloud &&
      env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION &&
      env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION !== "DEV" // exclude dev and CI environments
    ) {
      return {
        isAuthorized: false,
        error: "Not accessible on Litefuse Cloud",
      };
    }

    // Check if ADMIN_API_KEY is set
    if (!env.ADMIN_API_KEY) {
      logger.error("ADMIN_API_KEY is not set");
      return {
        isAuthorized: false,
        error: "ADMIN_API_KEY is not set",
      };
    }

    const [scheme, token] = authString.split(" ");
    if (
      scheme !== "Bearer" ||
      !token ||
      !isTokenValid(token, env.ADMIN_API_KEY)
    ) {
      return {
        isAuthorized: false,
        error: "Unauthorized: Invalid token",
      };
    }

    return {
      isAuthorized: true,
    };
  };

  /**
   * Verifies if the request is authorized to access admin APIs
   * @param headers The incoming HTTP headers
   * @param options Admin auth options
   * @returns An object with isAuthorized flag and optional error message
   */
  private static verifyAdminAuthFromHeader(
    headers: IncomingHttpHeaders,
    options: AdminAuthOptions = {},
  ): AdminAuthResult {
    // Check bearer token
    const { authorization } = headers;
    if (!authorization) {
      return {
        isAuthorized: false,
        error: "Unauthorized: No authorization header provided",
      };
    }
    return AdminApiAuthService.verifyAdminAuthFromAuthString(
      authorization,
      options,
    );
  }

  /**
   * Middleware function to handle admin authentication in Next.js API routes
   * @param req The Next.js API request
   * @param res The Next.js API response
   * @param options Admin auth options. By default, blocks access on Litefuse Cloud (isAllowedOnLangfuseCloud: false)
   * @returns true if authorized, false otherwise (and sets appropriate response)
   */
  public static handleAdminAuth(
    req: NextApiRequest,
    res: NextApiResponse,
    options: AdminAuthOptions = {},
  ): boolean {
    const authResult = AdminApiAuthService.verifyAdminAuthFromHeader(
      req.headers,
      options,
    );

    if (!authResult.isAuthorized) {
      if (authResult.error?.startsWith("Unauthorized")) {
        res.status(401).json({ error: authResult.error });
      } else {
        res.status(403).json({ error: authResult.error });
      }
      return false;
    }

    return true;
  }
}
