/**
 * Authentication guard hook
 * Determines if user should be redirected, signed out, or allowed to proceed
 */

import { i18nKey } from "@/src/features/i18n/i18nKey";
import { getDefaultPostLoginPath } from "@/src/features/auth/lib/getDefaultPostLoginPath";
import { useRouter } from "next/router";
import { useMemo } from "react";
import { PATH_CONSTANTS } from "../utils/pathClassification";
import { getSafeRedirectPath, stripBasePath, didDocumentLoadOnPath } from "@/src/utils/redirect";
import type { SessionContextValue } from "next-auth/react";

/** Actions the auth guard can request */
export type AuthGuardAction = "allow" | "loading" | "redirect" | "sign-out";

/** Result of auth guard evaluation */
export type AuthGuardResult =
  | { action: "allow" }
  | { action: "loading"; message: string }
  | { action: "redirect"; url: string; message: string }
  | { action: "sign-out"; message: string };

/**
 * Evaluates authentication state and determines appropriate action
 * Handles:
 * - Loading states
 * - Invalid users (session exists but user is null)
 * - Unauthenticated users on protected routes
 * - Authenticated users on auth pages (with redirect)
 *
 * @param session - Session object from useSession hook
 * @returns Guard state indicating what action to take
 */
export function useAuthGuard(
  session: SessionContextValue,
  _hideNavigation: boolean,
): AuthGuardResult {
  const router = useRouter();

  return useMemo(() => {
    const { pathname, query, asPath } = router;

    // Loading state
    if (session.status === "loading") {
      return { action: "loading", message: i18nKey("Loading") };
    }

    const isUnauthPath = PATH_CONSTANTS.unauthenticated.some((p) =>
      pathname.startsWith(p),
    );
    const isPublicPath = pathname.startsWith("/public/");

    // Check if path is publishable (can be accessed without authentication)
    const isPublishable = PATH_CONSTANTS.publishable.some((path) => {
      // Case 1: Exact match (e.g., pathname === "/auth/reset-password")
      if (pathname === path) return true;

      // Case 2: Prefix match for dynamic routes
      // Example: path = "/project/[projectId]/traces/[traceId]"
      //   -> pathPrefix = "/project/[^/]+/traces" (last segment removed, params converted to regex)
      //   -> matches pathname like "/project/abc123/traces/xyz789"
      // This allows shared trace/session links to be accessed without authentication
      const pathPrefix = path
        .split("/")
        .slice(0, -1)
        .join("/")
        .replace(/\[([^\]]+)\]/g, "[^/]+");
      const prefixRegex = new RegExp(`^${pathPrefix}/`);
      return prefixRegex.test(pathname);
    });

    // Invalid user - has session but no DB user
    // This can happen if user was deleted from DB but still has valid JWT
    if (
      session.data &&
      session.data.user === null &&
      !isUnauthPath &&
      !isPublishable &&
      !isPublicPath
    ) {
      return { action: "sign-out", message: i18nKey("Redirecting") };
    }

    // Unauthenticated user trying to access protected route
    if (
      session.status === "unauthenticated" &&
      !isUnauthPath &&
      !isPublishable &&
      !isPublicPath
    ) {
      // asPath already includes the base path when accessed via browser
      // Strip the base path if present to avoid double-prepending
      const rawPath = asPath || pathname || "/";
      const pathToStore = stripBasePath(rawPath);

      // Only include targetPath if it's not the root
      const targetPathQuery =
        pathToStore !== "/"
          ? `?targetPath=${encodeURIComponent(pathToStore)}`
          : "";

      return {
        action: "redirect",
        url: `/auth/sign-in${targetPathQuery}`,
        message: i18nKey("Redirecting"),
      };
    }

    // Authenticated user on authentication page - redirect to target or home
    if (session.status === "authenticated" && isUnauthPath) {
      const queryTargetPath = query.targetPath as string | undefined;
      // Explicit deep-link target takes precedence; otherwise enter the first
      // project (or stay on the organization overview when none exist).
      const routerRedirectUrl = queryTargetPath
        ? stripBasePath(getSafeRedirectPath(queryTargetPath))
        : getDefaultPostLoginPath(session.data?.user);
      return {
        action: "redirect",
        url: routerRedirectUrl,
        message: i18nKey("Redirecting"),
      };
    }

    // Authenticated user opening the app at `/` (full document load) — same
    // default as post-login. Only once per tab: after we auto-enter a project,
    // client-side visits to `/` (logo / breadcrumb) must stay on the org overview.
    // Without the one-shot flag, didDocumentLoadOnPath("/") stays true for the
    // whole document lifetime and would bounce logo clicks back to the project.
    if (session.status === "authenticated" && pathname === "/") {
      const defaultPath = getDefaultPostLoginPath(session.data?.user);
      if (
        defaultPath !== "/" &&
        didDocumentLoadOnPath("/") &&
        !hasCompletedRootAutoEnter()
      ) {
        // Keep useMemo pure — AppLayout marks completion when it actually redirects.
        return {
          action: "redirect",
          url: defaultPath,
          message: i18nKey("Redirecting"),
        };
      }
    }

    // All checks passed - allow access
    return { action: "allow" };
  }, [session.status, session.data, router]);
}

const ROOT_AUTO_ENTER_KEY = "lf:root-auto-enter-done";

function hasCompletedRootAutoEnter(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(ROOT_AUTO_ENTER_KEY) === "1";
  } catch {
    return false;
  }
}

/** Call from AppLayout when performing the root auto-enter redirect. */
export function markRootAutoEnterCompleted(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(ROOT_AUTO_ENTER_KEY, "1");
  } catch {
    // Ignore quota / private-mode failures; worst case is one extra redirect.
  }
}
