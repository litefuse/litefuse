import { signOut } from "next-auth/react";
import { env } from "@/src/env.mjs";

const LAST_USED_AUTH_METHOD_KEY = "langfuse_last_used_auth_method";

/**
 * Fully tear down the browser session for shared-domain deploys.
 *
 * next-auth signOut only expires cookies at the configured Path (e.g.
 * `/litefuse`). A leftover Path=/ session cookie still authenticates the
 * user, so `/auth/sso-initiate` skips Feishu and drops them back in.
 */
export async function forceSignOut(options?: {
  /** Where to land after logout. Defaults to site root (Chronicle portal). */
  redirectTo?: string;
}): Promise<void> {
  const redirectTo = options?.redirectTo ?? "/";

  try {
    sessionStorage.clear();
  } catch {
    // ignore (private mode / unavailable)
  }

  try {
    localStorage.removeItem(LAST_USED_AUTH_METHOD_KEY);
  } catch {
    // ignore
  }

  // Best-effort NextAuth sign-out (may only clear Path=basePath cookies).
  try {
    await signOut({ redirect: false });
  } catch {
    // continue — clear-session below is the authoritative wipe
  }

  // Expire session cookies at Path=/ and Path=basePath (httpOnly, server-set).
  const clearUrl = `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth/clear-session`;
  try {
    await fetch(clearUrl, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    // ignore network errors; hard navigation still follows
  }

  window.location.assign(redirectTo);
}
