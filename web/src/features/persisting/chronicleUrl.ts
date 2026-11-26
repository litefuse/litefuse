import { env } from "@/src/env.mjs";

const SECTION_TO_PAGE: Record<string, string> = {
  datasets: "catalog",
  runs: "runs",
  analysis: "tools",
  storage: "physical",
  requests: "requests",
};

export function chroniclePageForSection(section: string): string {
  return SECTION_TO_PAGE[section] ?? "catalog";
}

/**
 * Switch Chronicle's active page inside an already-loaded same-origin iframe.
 * Avoids a full document reload (and the dark shell flash).
 * Uses replaceState so browser Back does not desync the iframe and outer route.
 */
export function navigateChronicleEmbed(win: Window, section: string): void {
  const page = chroniclePageForSection(section);
  const params = new URLSearchParams({ page, embed: "1" });
  const next = `${win.location.pathname}?${params.toString()}`;
  win.history.replaceState(win.history.state, "", next);
  win.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Embed URL for the current browser.
 * - Explicit NEXT_PUBLIC_PERSISTING_CHRONICLE_URL always wins when set.
 * - localhost without override: same-origin frame proxy (port-forward safe).
 * - otherwise: same-origin Chronicle root (Litefuse under /litefuse) or "".
 */
export function buildChronicleEmbedUrl(section: string): string {
  const page = chroniclePageForSection(section);
  const params = new URLSearchParams({ page, embed: "1" });
  const override = env.NEXT_PUBLIC_PERSISTING_CHRONICLE_URL?.replace(/\/$/, "");
  if (override) {
    return `${override}/?${params.toString()}`;
  }
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      const basePath = env.NEXT_PUBLIC_BASE_PATH ?? "";
      return `${basePath}/api/persisting/frame?${params.toString()}`;
    }
  }
  // Same-origin root when Chronicle is served next to Litefuse (e.g. /).
  // Avoid recursively embedding Litefuse in itself when basePath is empty —
  // require an explicit override or a non-root basePath layout in production.
  const basePath = env.NEXT_PUBLIC_BASE_PATH?.replace(/\/$/, "") ?? "";
  if (basePath) {
    return `/?${params.toString()}`;
  }
  // No safe embed target configured.
  return "";
}
