import { signOut } from "next-auth/react";
import { z } from "zod/v4";
import { env } from "@/src/env.mjs";
import { ssoLogoutUrlSchema } from "@/src/features/enterprise/sso/ssoConfigSchema";

const logoutResponseSchema = z.object({ url: ssoLogoutUrlSchema.nullable() });

/** Return the destination only after NextAuth has completed local sign-out. */
export async function signOutWithSso(): Promise<string> {
  let callbackUrl = `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/auth/sign-in`;
  let idpLogoutUrl: string | null = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth/sso-logout`,
      {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error("SSO logout is unavailable");
    idpLogoutUrl = logoutResponseSchema.parse(await response.json()).url;
  } catch {
    // An IdP preparation failure must not prevent the user from signing out locally.
    callbackUrl += "?error=SSOLogoutError";
  } finally {
    clearTimeout(timeout);
  }

  const result = await signOut({ redirect: false, callbackUrl });
  const localRedirect = new URL(result.url);
  // A rejected NextAuth sign-out (e.g. failed CSRF validation) must complete locally first.
  if (localRedirect.pathname + localRedirect.search !== callbackUrl) {
    throw new Error("Local sign-out was not completed");
  }
  return idpLogoutUrl ?? result.url;
}
