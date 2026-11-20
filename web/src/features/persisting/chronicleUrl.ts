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
 */
export function navigateChronicleEmbed(win: Window, section: string): void {
  const page = chroniclePageForSection(section);
  const params = new URLSearchParams({ page, embed: "1" });
  const next = `${win.location.pathname}?${params.toString()}`;
  win.history.pushState(win.history.state, "", next);
  win.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Embed URL for the current browser.
 * - localhost: stay on this dev server. The browser is often port-forwarded,
 *   so 127.0.0.1:8081 would be the user's machine, not Chronicle.
 * - otherwise: same-origin Chronicle root (Litefuse is mounted under /litefuse).
 * - NEXT_PUBLIC_PERSISTING_CHRONICLE_URL overrides the non-local case.
 */
export function buildChronicleEmbedUrl(section: string): string {
  const page = chroniclePageForSection(section);
  const params = new URLSearchParams({ page, embed: "1" });
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      const basePath = env.NEXT_PUBLIC_BASE_PATH ?? "";
      return `${basePath}/api/persisting/frame?${params.toString()}`;
    }
  }
  const override = env.NEXT_PUBLIC_PERSISTING_CHRONICLE_URL?.replace(/\/$/, "");
  return `${override ?? ""}/?${params.toString()}`;
}
