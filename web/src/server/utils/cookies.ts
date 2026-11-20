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

/**
 * Cookie names that may exist from current config or prior deploys
 * (with/without __Secure-/__Host-, with/without cloud region suffix).
 */
function getAuthCookieNamesToClear(): string[] {
  const region = env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION
    ? `.${env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION}`
    : "";
  const names = new Set<string>();

  const addWithChunks = (name: string, chunked: boolean) => {
    names.add(name);
    if (chunked) {
      for (let i = 0; i < 6; i++) {
        names.add(`${name}.${i}`);
      }
    }
  };

  for (const base of AUTH_COOKIE_BASE_NAMES) {
    const isSession = base === "next-auth.session-token";
    // Current configured name
    addWithChunks(getCookieName(base), isSession);
    // Common leftovers from path/prefix/region mismatches across deploys
    for (const prefix of ["", "__Secure-"]) {
      addWithChunks(`${prefix}${base}`, isSession);
      if (region) {
        addWithChunks(`${prefix}${base}${region}`, isSession);
      }
    }
  }
  // NextAuth default CSRF uses __Host- when secure
  names.add("__Host-next-auth.csrf-token");
  if (region) {
    names.add(`__Host-next-auth.csrf-token${region}`);
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
 * Build Set-Cookie values that expire auth cookies at every plausible
 * path/domain so logout cannot leave a stale session on a shared-domain host.
 */
export function buildAuthCookieClearHeaders(): string[] {
  const configuredDomain = env.NEXTAUTH_COOKIE_DOMAIN;
  // Clear both with and without Domain — a cookie is only deleted when name,
  // path, and domain match how it was originally set.
  const domainVariants: Array<string | undefined> = configuredDomain
    ? [configuredDomain, undefined]
    : [undefined];
  const secure = shouldSecureCookies();

  const headers: string[] = [];
  const seen = new Set<string>();

  for (const name of getAuthCookieNamesToClear()) {
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
export function appendAuthCookieClearHeaders(res: NextApiResponse): void {
  for (const header of buildAuthCookieClearHeaders()) {
    res.appendHeader("Set-Cookie", header);
  }
}
