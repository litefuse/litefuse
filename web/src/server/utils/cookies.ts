import type { NextApiResponse } from "next";
import { env } from "@/src/env.mjs";

// Use secure cookies on https hostnames, exception for Vercel which sets NEXTAUTH_URL without the protocol
const shouldSecureCookies = () =>
  env.NEXTAUTH_URL.startsWith("https://") || process.env.VERCEL === "1";

export const getCookieOptions = () => ({
  domain: env.NEXTAUTH_COOKIE_DOMAIN ?? undefined,
  httpOnly: true,
  sameSite: "lax" as const,
  path: env.NEXT_PUBLIC_BASE_PATH || "/",
  secure: shouldSecureCookies(),
});

export const getCookieName = (name: string) =>
  [
    shouldSecureCookies() ? "__Secure-" : "",
    name,
    env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION
      ? `.${env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION}`
      : "",
  ].join("");

const AUTH_COOKIE_BASE_NAMES = [
  "next-auth.session-token",
  "next-auth.csrf-token",
  "next-auth.callback-url",
  "next-auth.state",
  "next-auth.nonce",
  "next-auth.pkce.code_verifier",
] as const;

/**
 * Paths that may hold auth cookies when Litefuse shares a domain with another
 * app (e.g. Chronicle at `/`, Litefuse at `/litefuse`). Clearing only the
 * configured basePath leaves a Path=/ cookie behind and re-entry skips SSO.
 */
function getAuthCookieClearPaths(): string[] {
  const basePath = env.NEXT_PUBLIC_BASE_PATH?.replace(/\/$/, "") || "";
  const paths = new Set<string>(["/"]);
  if (basePath) {
    paths.add(basePath);
  }
  return Array.from(paths);
}

function isAuthCookieName(name: string): boolean {
  return (
    name.includes("next-auth.") ||
    name.startsWith("__Secure-next-auth.") ||
    name.startsWith("__Host-next-auth.")
  );
}

/**
 * Cookie names to expire: those present on the request that look like NextAuth
 * cookies, plus the configured session token name as a fallback.
 */
function getAuthCookieNamesToClear(presentCookieNames: string[]): string[] {
  const names = new Set<string>();

  for (const name of presentCookieNames) {
    if (isAuthCookieName(name)) {
      names.add(name);
    }
  }

  // Always clear the active configured session token (and common chunks).
  const sessionName = getCookieName("next-auth.session-token");
  names.add(sessionName);
  for (let i = 0; i < 6; i++) {
    names.add(`${sessionName}.${i}`);
  }

  // Also clear plain / __Secure- variants of the base session name if present
  // on the request — already covered by isAuthCookieName above.

  // Ensure CSRF host-prefixed name is cleared when present.
  for (const base of AUTH_COOKIE_BASE_NAMES) {
    const configured = getCookieName(base);
    if (presentCookieNames.includes(configured)) {
      names.add(configured);
    }
  }

  return Array.from(names);
}

function serializeExpiredCookie(
  name: string,
  path: string,
  domain?: string,
  secure?: boolean,
): string {
  const parts = [
    `${name}=`,
    `Path=${path}`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (domain) {
    parts.push(`Domain=${domain}`);
  }
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/**
 * Build Set-Cookie values that expire the auth cookies that are actually
 * present (plus the configured session token), at Path=/ and Path=basePath.
 * Avoids emitting dozens of unused Set-Cookie headers that can blow Nginx
 * proxy buffers (502 on sign-out).
 */
export function buildAuthCookieClearHeaders(
  presentCookieNames: string[] = [],
): string[] {
  const configuredDomain = env.NEXTAUTH_COOKIE_DOMAIN;
  const domainVariants: Array<string | undefined> = configuredDomain
    ? [configuredDomain, undefined]
    : [undefined];
  const secure = shouldSecureCookies();

  const headers: string[] = [];
  const seen = new Set<string>();

  for (const name of getAuthCookieNamesToClear(presentCookieNames)) {
    for (const path of getAuthCookieClearPaths()) {
      for (const domain of domainVariants) {
        // __Host- cookies: Secure + Path=/ + no Domain only
        if (name.startsWith("__Host-")) {
          if (path !== "/" || domain) continue;
          const header = serializeExpiredCookie(name, "/", undefined, true);
          if (!seen.has(header)) {
            seen.add(header);
            headers.push(header);
          }
          continue;
        }

        const useSecure = name.startsWith("__Secure-") ? true : secure;
        const header = serializeExpiredCookie(name, path, domain, useSecure);
        if (!seen.has(header)) {
          seen.add(header);
          headers.push(header);
        }
      }
    }
  }

  return headers;
}

/** Append expired auth cookies onto an existing API response. */
export function appendAuthCookieClearHeaders(
  res: NextApiResponse,
  presentCookieNames: string[] = [],
): void {
  for (const header of buildAuthCookieClearHeaders(presentCookieNames)) {
    res.appendHeader("Set-Cookie", header);
  }
}
