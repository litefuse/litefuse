/**
 * Force-clear Litefuse NextAuth session cookies that may survive a normal
 * signOut when Path=/ leftovers exist on a shared-domain deploy
 * (Chronicle at `/`, Litefuse at `/litefuse`).
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { env } from "@/src/env.mjs";
import { appendAuthCookieClearHeaders } from "@/src/server/utils/cookies";

function isSameOriginRequest(req: NextApiRequest): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site") {
    return false;
  }

  const host = req.headers.host;
  if (!host) {
    return false;
  }

  const requestOrigins = new Set<string>();
  try {
    requestOrigins.add(new URL(env.NEXTAUTH_URL).origin);
  } catch {
    // ignore invalid NEXTAUTH_URL
  }
  const protoHeader = req.headers["x-forwarded-proto"];
  const proto =
    (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader)
      ?.split(",")[0]
      ?.trim() || (env.NEXTAUTH_URL.startsWith("https") ? "https" : "http");
  requestOrigins.add(`${proto}://${host}`);

  const origin = req.headers.origin;
  if (origin) {
    return requestOrigins.has(origin);
  }

  const referer = req.headers.referer;
  if (referer) {
    try {
      return requestOrigins.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  // Same-origin fetch often sends Sec-Fetch-Site without Origin.
  return site === "same-origin" || site === "same-site";
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isSameOriginRequest(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  appendAuthCookieClearHeaders(res, Object.keys(req.cookies ?? {}));
  res.status(200).json({ ok: true });
}
