// k6 load test that REPLAYS every tRPC read (query) a real page fired.
//
// Instead of hand-writing each procedure's input, this reads a HAR exported from
// the browser, extracts all GET requests to /api/trpc/* (tRPC queries — mutations
// are POST and are skipped), and replays them under load with a logged-in
// NextAuth session cookie. This guarantees full, faithful coverage of whatever
// page you recorded (e.g. the traces list + a trace detail view).
//
// How to capture the HAR:
//   1. Open the page in Chrome with DevTools → Network tab, "Preserve log" on.
//   2. Reload the page (and click into a trace to capture the detail calls too).
//   3. Right-click any request → "Save all as HAR with content".
//   4. Save it as e.g. scripts/loadtest/traces.har
//
// Run:
//   HAR=scripts/loadtest/traces.har \
//   EMAIL=berkin@abc.com PASSWORD=Berkin_123456 \
//   VUS=10 DURATION=1m \
//   k6 run scripts/loadtest/trpc-har-replay.js

import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Trend } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";

// ---- config -----------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const EMAIL = __ENV.EMAIL || "demo@litefuse.ai";
const PASSWORD = __ENV.PASSWORD || "password";
const VUS = parseInt(__ENV.VUS || "10", 10);
const DURATION = __ENV.DURATION || "1m";
const HAR_PATH = __ENV.HAR || "scripts/loadtest/traces.har";
// Procedures to drop (substring match on the procedure name). Default strips the
// Postgres/S3-backed queries so the test isolates Doris read latency.
// Non-Doris on the Tracing page (verified against router impls):
//   TableViewPresets.* (saved view/column config), comments.*, media.*,
//   annotationQueues.*, datasets.* — all Prisma/Postgres (+ S3 for media).
// Override with EXCLUDE="a,b" or EXCLUDE="" to replay everything.
const NON_DORIS_DEFAULT =
  "TableViewPresets.,comments.,media.,annotationQueues.,datasets.";
const EXCLUDE = (
  __ENV.EXCLUDE === undefined ? NON_DORIS_DEFAULT : __ENV.EXCLUDE
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---- parse HAR at init: collect unique tRPC GET requests --------------------
// Returns [{ proc, path }] where path is "/api/trpc/<proc>?input=..." re-hosted
// onto BASE_URL. Mutations (POST) are excluded — this is a read load test.
function loadHarRequests() {
  const har = JSON.parse(open(HAR_PATH));
  const entries = (har.log && har.log.entries) || [];
  const seen = {};
  const reqs = [];
  for (const e of entries) {
    const r = e.request;
    if (!r || r.method !== "GET") continue;
    const u = r.url;
    if (!u.includes("/api/trpc/")) continue;
    // keep path + query only, re-host onto BASE_URL
    const m = u.match(/\/api\/trpc\/[^\s]*/);
    if (!m) continue;
    const path = m[0];
    if (seen[path]) continue; // drop exact-duplicate URLs
    seen[path] = true;
    // procedure name = segment between /api/trpc/ and ? (may contain commas if batched)
    const proc = decodeURIComponent(
      path.replace(/^\/api\/trpc\//, "").split("?")[0],
    );
    if (EXCLUDE.some((x) => proc.includes(x))) continue; // skip excluded procs
    reqs.push({ proc, path });
  }
  return reqs;
}

const REQUESTS = loadHarRequests();

// One latency Trend per unique procedure (declared in init context).
const trends = {};
for (const { proc } of REQUESTS) {
  if (!trends[proc]) {
    const metricName = "lat_" + proc.replace(/[^A-Za-z0-9_]/g, "_");
    trends[proc] = new Trend(metricName, true);
  }
}

export const options = {
  scenarios: {
    reads: { executor: "constant-vus", vus: VUS, duration: DURATION },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800", "p(99)<2000"],
  },
};

// ---- auth: one credentials login, reused by all VUs -------------------------
function login() {
  const csrfRes = http.get(`${BASE_URL}/api/auth/csrf`);
  check(csrfRes, { "csrf 200": (r) => r.status === 200 });
  const csrfToken = csrfRes.json("csrfToken");
  if (!csrfToken) fail(`could not get csrfToken: ${csrfRes.body}`);

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

  const jar = http.cookieJar();
  const token = jar.cookiesForURL(BASE_URL)["next-auth.session-token"];
  if (!token || !token[0]) {
    fail(
      `login failed — no next-auth.session-token (status ${loginRes.status}). ` +
        `Check EMAIL/PASSWORD and AUTH_DISABLE_USERNAME_PASSWORD != "true".`,
    );
  }
  return token[0];
}

export function setup() {
  if (REQUESTS.length === 0) {
    fail(`no /api/trpc GET requests found in ${HAR_PATH}`);
  }
  const cookie = login();
  console.log(
    `setup: logged in, replaying ${REQUESTS.length} unique tRPC queries from ${HAR_PATH}`,
  );
  for (const { proc } of REQUESTS) console.log(`  - ${proc}`);
  return { cookie };
}

// ---- VU loop: fire every recorded query once per iteration ------------------
export default function (data) {
  const headers = { Cookie: `next-auth.session-token=${data.cookie}` };

  // batch them the way a page load does: all in flight together
  const batch = REQUESTS.map(({ path, proc }) => ({
    method: "GET",
    url: `${BASE_URL}${path}`,
    params: { headers, tags: { proc } },
  }));
  const responses = http.batch(batch);

  responses.forEach((res, i) => {
    const { proc } = REQUESTS[i];
    trends[proc].add(res.timings.duration);
    const ok = check(res, { [`${proc} 200`]: (r) => r.status === 200 });
    if (!ok && __ENV.DEBUG) {
      console.error(
        `${proc} -> ${res.status}: ${String(res.body).slice(0, 300)}`,
      );
    }
  });

  sleep(0.3);
}

export function handleSummary(data) {
  return { stdout: textSummary(data, { indent: " ", enableColors: true }) };
}
