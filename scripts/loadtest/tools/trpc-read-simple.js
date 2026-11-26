// k6 load test for Litefuse tRPC read (page) endpoints.
//
// These are the endpoints the web UI calls (/api/trpc/*). They authenticate
// with a NextAuth session cookie, NOT an API key — so this script logs in once
// per VU via the credentials provider, captures `next-auth.session-token`, and
// reuses it for all queries.
//
// Run:
//   k6 run scripts/loadtest/trpc-read.js
//   BASE_URL=http://localhost:3000 VUS=20 DURATION=2m k6 run scripts/loadtest/trpc-read.js
//
// Install k6 (macOS): brew install k6

import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Trend } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

// ---- config -----------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const PROJECT_ID = __ENV.PROJECT_ID || "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a";
const EMAIL = __ENV.EMAIL || "demo@litefuse.ai";
const PASSWORD = __ENV.PASSWORD || "password";
const VUS = parseInt(__ENV.VUS || "10", 10);
const DURATION = __ENV.DURATION || "1m";

// Per-endpoint latency trends. k6 requires metrics to be declared in the init
// context (module top-level), so we predeclare one Trend per procedure we hit.
const PROCS = ["traces.all", "traces.countAll", "sessions.all", "traces.byId"];
const trends = {};
for (const p of PROCS)
  trends[p] = new Trend(`lat_${p.replace(/\./g, "_")}`, true);
function trend(name) {
  return trends[name]; // undefined-safe: only declared procs are tracked
}

export const options = {
  scenarios: {
    reads: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"], // <1% errors
    http_req_duration: ["p(95)<800", "p(99)<2000"],
  },
};

// ---- auth -------------------------------------------------------------------
// One credentials login. Returns the session cookie value used for all VUs.
function login() {
  // 1) CSRF token + csrf cookie (cookie is stored in the per-VU jar automatically).
  const csrfRes = http.get(`${BASE_URL}/api/auth/csrf`);
  check(csrfRes, { "csrf 200": (r) => r.status === 200 });
  const csrfToken = csrfRes.json("csrfToken");
  if (!csrfToken) fail(`could not get csrfToken: ${csrfRes.body}`);

  // 2) credentials callback — NextAuth expects x-www-form-urlencoded.
  const loginRes = http.post(
    `${BASE_URL}/api/auth/callback/credentials`,
    {
      email: EMAIL,
      password: PASSWORD,
      csrfToken,
      callbackUrl: BASE_URL,
      json: "true",
    },
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );

  // Session cookie lands in the jar after the redirect chain.
  const jar = http.cookieJar();
  const cookies = jar.cookiesForURL(BASE_URL);
  const token = cookies["next-auth.session-token"];
  if (!token || !token[0]) {
    fail(
      `login failed — no next-auth.session-token (status ${loginRes.status}). ` +
        `Check EMAIL/PASSWORD and that AUTH_DISABLE_USERNAME_PASSWORD != "true".`,
    );
  }
  return token[0];
}

// ---- tRPC helper ------------------------------------------------------------
function trpcQuery(proc, input, cookie) {
  // superjson wraps the input as { json: <value> }.
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  const res = http.get(`${BASE_URL}/api/trpc/${proc}?input=${encoded}`, {
    headers: { Cookie: `next-auth.session-token=${cookie}` },
    tags: { proc },
  });
  const t = trend(proc);
  if (t) t.add(res.timings.duration);
  const ok = check(res, {
    [`${proc} 200`]: (r) => r.status === 200,
  });
  if (!ok && __ENV.DEBUG) {
    console.error(
      `${proc} -> ${res.status}: ${String(res.body).slice(0, 300)}`,
    );
  }
  return res;
}

// ---- setup: log in + grab real ids for detail endpoints ---------------------
export function setup() {
  const cookie = login();

  // Pull one page of traces so byId / observations.byId hit real data.
  const tracesRes = trpcQuery(
    "traces.all",
    {
      projectId: PROJECT_ID,
      searchQuery: null,
      searchType: [],
      filter: null,
      orderBy: null,
      page: 0,
      limit: 50,
    },
    cookie,
  );

  let traceIds = [];
  try {
    const traces = tracesRes.json("result.data.json.traces") || [];
    traceIds = traces.map((t) => t.id).filter(Boolean);
  } catch (e) {
    // tolerate shape differences; detail endpoints just get skipped if empty
  }

  console.log(
    `setup: logged in, found ${traceIds.length} trace ids for detail queries`,
  );
  return { cookie, traceIds };
}

// ---- the VU loop ------------------------------------------------------------
export default function (data) {
  const cookie = data.cookie;

  // List traces (the heaviest dashboard query).
  trpcQuery(
    "traces.all",
    {
      projectId: PROJECT_ID,
      searchQuery: null,
      searchType: [],
      filter: null,
      orderBy: null,
      page: 0,
      limit: 50,
    },
    cookie,
  );

  // Count (runs alongside the list on the traces page).
  trpcQuery(
    "traces.countAll",
    {
      projectId: PROJECT_ID,
      searchQuery: null,
      searchType: [],
      filter: null,
      orderBy: null,
      page: 0,
      limit: 50,
    },
    cookie,
  );

  // Sessions list.
  trpcQuery(
    "sessions.all",
    {
      projectId: PROJECT_ID,
      filter: null,
      orderBy: null,
      page: 0,
      limit: 50,
    },
    cookie,
  );

  // Trace detail on a real id (rotates per iteration).
  if (data.traceIds && data.traceIds.length > 0) {
    const id = data.traceIds[__ITER % data.traceIds.length];
    trpcQuery(
      "traces.byId",
      {
        traceId: id,
        projectId: PROJECT_ID,
        timestamp: null,
        fromTimestamp: null,
        verbosity: "full",
      },
      cookie,
    );
  }

  sleep(0.3);
}

// Per-endpoint p95/p99 in the final summary.
export function handleSummary(data) {
  return { stdout: textSummary(data, { indent: " ", enableColors: true }) };
}
