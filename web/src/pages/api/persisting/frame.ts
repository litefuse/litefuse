import { type NextApiRequest, type NextApiResponse } from "next";

const ALLOWED_PAGES = new Set([
  "catalog",
  "runs",
  "tools",
  "physical",
  "requests",
  "detail",
  "home",
]);

const LOCAL_CHRONICLE_ORIGIN = "http://127.0.0.1:8081";

const EMBED_HEIGHT_STYLE = `<style id="deeptrace-embed-height">
  html, body, #main {
    height: 100% !important;
    max-height: 100% !important;
    overflow: hidden !important;
    background: #f5f7fa !important;
  }
  .pc2-shell,
  .pc2-shell.embed {
    height: 100% !important;
    max-height: 100% !important;
    min-height: 0 !important;
    background: #f5f7fa !important;
  }
</style>`;

function buildHistoryPatch(keepEmbed: boolean): string {
  const embedLine = keepEmbed
    ? `if (search.indexOf("embed=") === -1) {
        search += (search ? "&" : "?") + "embed=1";
      }`
    : "";
  return `<script id="deeptrace-chronicle-history">
  (function () {
    var base = location.pathname;
    function rewrite(url) {
      if (typeof url !== "string" || url.length === 0) return url;
      var queryIndex = url.indexOf("?");
      var search = queryIndex >= 0 ? url.slice(queryIndex) : "";
      ${embedLine}
      return base + search;
    }
    var push = history.pushState.bind(history);
    var replace = history.replaceState.bind(history);
    history.pushState = function (state, title, url) {
      return push(state, title, rewrite(url));
    };
    history.replaceState = function (state, title, url) {
      return replace(state, title, rewrite(url));
    };
  })();
</script>`;
}

/**
 * Local-dev document proxy. The Next server (same machine as Chronicle)
 * fetches the page; the browser only talks to this dev origin (port 3000).
 *
 * - embed=1 (default): hide Chronicle rail (Litefuse sidebar owns nav)
 * - embed=0: full Chronicle UI including rail (standalone preview via :3000)
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end("Method not allowed");
  }

  const page = typeof req.query.page === "string" ? req.query.page : "catalog";
  if (!ALLOWED_PAGES.has(page)) {
    return res.status(400).end("Unknown Chronicle page");
  }

  const embedParam =
    typeof req.query.embed === "string" ? req.query.embed : "1";
  const embedded = embedParam !== "0" && embedParam !== "false";

  const params = new URLSearchParams({ page });
  if (embedded) params.set("embed", "1");
  const upstreamUrl = `${LOCAL_CHRONICLE_ORIGIN}/?${params.toString()}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { Accept: "text/html" },
      cache: "no-store",
    });
    const html = await upstream.text();
    const inject = `${EMBED_HEIGHT_STYLE}${buildHistoryPatch(embedded)}`;
    const body = html.includes("</head>")
      ? html.replace("</head>", `${inject}</head>`)
      : `${inject}${html}`;
    res.status(upstream.status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    // Allow top-level navigation for standalone preview in the same tab.
    if (!embedded) {
      res.removeHeader("X-Frame-Options");
    } else {
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
    }
    return res.send(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "fetch failed";
    return res
      .status(502)
      .send(`Cannot reach Chronicle at ${LOCAL_CHRONICLE_ORIGIN}: ${message}`);
  }
}
