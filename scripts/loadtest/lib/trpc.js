// tRPC helpers: superjson encoding, URL building, per-page metrics, batched runs.
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { BASE_URL } from "./config.js";

// Encode a plain value into the superjson `{ json, meta }` envelope the tRPC
// client uses. Date instances are emitted as ISO strings + a meta marker;
// `undefined` is emitted as null + a marker. Mirrors superjson on the wire so
// servers that expect typed inputs (Date filters, etc.) parse correctly.
export function superjson(value) {
  const meta = {};
  function walk(v, path) {
    if (v instanceof Date) {
      meta[path.join(".")] = ["Date"];
      return v.toISOString();
    }
    if (v === undefined) {
      meta[path.join(".")] = ["undefined"];
      return null;
    }
    if (Array.isArray(v))
      return v.map((x, i) => walk(x, path.concat(String(i))));
    if (v !== null && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], path.concat(k));
      return o;
    }
    return v;
  }
  const json = walk(value, []);
  const out = { json };
  if (Object.keys(meta).length) out.meta = { values: meta };
  return out;
}

export function trpcUrl(proc, input) {
  const enc = encodeURIComponent(JSON.stringify(superjson(input)));
  return `${BASE_URL}/api/trpc/${proc}?input=${enc}`;
}

// Declare one latency Trend per `<page>.<proc>` (must run in the init context).
// `pages` is the array of selected page modules.
export function makeTrends(pages) {
  const trends = {};
  for (const p of pages) {
    for (const proc of p.procs) {
      const key = `${p.name}.${proc}`;
      trends[key] = new Trend(
        "lat_" + key.replace(/[^A-Za-z0-9_]/g, "_"),
        true,
      );
    }
  }
  return trends;
}

// Fire every query for a page concurrently (like a real page load) and record
// each response against its `<page>.<proc>` Trend.
export function runBatch(pageName, queries, cookie, trends) {
  if (!queries.length) return [];
  const headers = { Cookie: `next-auth.session-token=${cookie}` };
  const batch = queries.map((q) => ({
    method: "GET",
    url: trpcUrl(q.proc, q.input),
    params: { headers, tags: { page: pageName, proc: q.proc } },
  }));
  const responses = http.batch(batch);
  responses.forEach((res, i) => {
    const q = queries[i];
    const t = trends[`${pageName}.${q.proc}`];
    if (t) t.add(res.timings.duration);
    const ok = check(res, {
      [`${pageName}/${q.proc} 200`]: (r) => r.status === 200,
    });
    if (!ok && __ENV.DEBUG) {
      console.error(
        `${q.proc} -> ${res.status}: ${String(res.body).slice(0, 200)}`,
      );
    }
  });
  return responses;
}

// Single GET for discover() steps. Returns the unwrapped `result.data.json`
// payload, or null on error.
export function trpcGet(proc, input, cookie) {
  const res = http.get(trpcUrl(proc, input), {
    headers: { Cookie: `next-auth.session-token=${cookie}` },
  });
  try {
    return res.json("result.data.json");
  } catch (e) {
    return null;
  }
}
