import { type NextApiRequest, type NextApiResponse } from "next";
import { getToken } from "next-auth/jwt";
import { env } from "@/src/env.mjs";
import { getCookieName } from "@/src/server/utils/cookies";
import { getSsoLogoutConfig } from "@/src/features/enterprise/sso/ssoProviders";
import { createSsoLogoutUrl } from "@/src/features/enterprise/sso/ssoLogout";
import { ssoErrorContext } from "@/src/features/enterprise/sso/ssoErrorContext";
import { logger } from "@langfuse/shared/src/server";

/** Prepare a browser redirect. Local logout still goes through NextAuth's CSRF-protected POST. */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const token = await getToken({
      // Only the current browser's cookies identify the session being signed out.
      // getToken only reads cookies and headers from the request.
      req: { cookies: req.cookies, headers: {} } as NextApiRequest,
      secret: env.NEXTAUTH_SECRET,
      cookieName: getCookieName("next-auth.session-token"),
    });
    if (!token?.ssoProviderId) return res.status(200).json({ url: null });

    const config = await getSsoLogoutConfig(token.ssoProviderId);
    if (!config) return res.status(200).json({ url: null });
    const bindingMatches = token.ssoLogoutBinding === config.binding;
    const idToken = bindingMatches ? token.ssoIdToken : undefined;
    if (config.logout.requireIdToken && !idToken) {
      logger.error("Failed to prepare Enterprise SSO logout", {
        reason: !bindingMatches
          ? "id_token_binding_mismatch"
          : token.ssoLogoutError === "id_token_too_large"
            ? "id_token_too_large"
            : "id_token_missing",
      });
      return res.status(503).json({ error: "SSO logout is unavailable" });
    }

    // Use deployment configuration, never request Host headers or a client-supplied return URL.
    const publicUrl = /^https?:\/\//.test(env.NEXTAUTH_URL)
      ? env.NEXTAUTH_URL
      : `https://${env.NEXTAUTH_URL}`;
    const returnTo = new URL(
      `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/auth/sign-in`,
      new URL(publicUrl).origin,
    ).toString();
    return res.status(200).json({
      url: createSsoLogoutUrl({
        ...config,
        returnTo,
        idToken,
      }),
    });
  } catch (error) {
    // URLs and tokens can contain sensitive claims; do not log them or return exception details.
    logger.error(
      "Failed to prepare Enterprise SSO logout",
      ssoErrorContext(error),
    );
    return res.status(503).json({ error: "SSO logout is unavailable" });
  }
}
