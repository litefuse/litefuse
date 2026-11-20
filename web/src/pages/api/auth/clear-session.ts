/**
 * Force-clear Litefuse NextAuth session cookies that may survive a normal
 * signOut when Path=/ leftovers exist on a shared-domain deploy
 * (Chronicle at `/`, Litefuse at `/litefuse`).
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { appendAuthCookieClearHeaders } from "@/src/server/utils/cookies";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  appendAuthCookieClearHeaders(res);
  res.status(200).json({ ok: true });
}
