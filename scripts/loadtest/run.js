// Litefuse web page load test — entrypoint.
//
// Selects one (or all) page module(s) via the PAGE env var, logs in once,
// discovers any ids the page's detail queries need, then replays every Doris
// read query that page fires — concurrently, like a real page load.
//
//   PAGE=tracing VUS=10 DURATION=1m k6 run scripts/loadtest/run.js
//   PAGE=all     VUS=20 DURATION=2m k6 run scripts/loadtest/run.js
//
// See lib/config.js for all env vars (BASE_URL, PROJECT_ID, EMAIL, PASSWORD, …).
import { sleep } from "k6";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";
import { PAGES } from "./pages/index.js";
import { login } from "./lib/auth.js";
import { makeTrends, runBatch } from "./lib/trpc.js";
import { VUS, DURATION, PAGE, SLEEP } from "./lib/config.js";

const selected = PAGE === "all" ? Object.values(PAGES) : [PAGES[PAGE]];
if (selected.some((p) => !p)) {
  throw new Error(
    `unknown PAGE='${PAGE}'. Known: ${Object.keys(PAGES).join(", ")}, or 'all'.`,
  );
}

const TRENDS = makeTrends(selected);

export const options = {
  scenarios: {
    reads: { executor: "constant-vus", vus: VUS, duration: DURATION },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<2000"],
  },
};

export function setup() {
  const cookie = login();
  const ids = {};
  for (const p of selected) {
    ids[p.name] = p.discover ? p.discover(cookie) : {};
    const d = ids[p.name] || {};
    console.log(
      `setup[${p.name}]: ${(d.traces || []).length} traces, ` +
        `${(d.observations || []).length} observations discovered`,
    );
  }
  return { cookie, ids };
}

export default function (data) {
  for (const p of selected) {
    runBatch(p.name, p.queries({ ids: data.ids[p.name] }), data.cookie, TRENDS);
  }
  sleep(SLEEP);
}

export function handleSummary(data) {
  return { stdout: textSummary(data, { indent: " ", enableColors: true }) };
}
