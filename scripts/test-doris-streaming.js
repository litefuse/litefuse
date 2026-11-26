/* eslint-disable */
/**
 * Compare buffered vs row-by-row streaming reads against Doris over MySQL protocol.
 * Run with --expose-gc for cleaner heap measurements:
 *   node --expose-gc scripts/test-doris-streaming.js
 *
 * Env overrides: DORIS_HOST, DORIS_PORT, DORIS_USER, DORIS_PASSWORD, DORIS_DB, DORIS_PROJECT_ID
 */

const path = require("path");
const mysql = require(
  path.join(__dirname, "..", "packages/shared/node_modules/mysql2/promise"),
);
const mysqlCallback = require(
  path.join(__dirname, "..", "packages/shared/node_modules/mysql2"),
);

const config = {
  host: process.env.DORIS_HOST || "127.0.0.1",
  port: Number(process.env.DORIS_PORT || 41930),
  user: process.env.DORIS_USER || "root",
  password: process.env.DORIS_PASSWORD || "",
  database: process.env.DORIS_DB || "langfuse",
  timezone: "+00:00",
  dateStrings: false,
};

const projectId = process.env.DORIS_PROJECT_ID || "cmohzoe670006z407sgvdpn72";

// Lightweight columns only — we're testing streaming mechanics, not bandwidth.
// No LIMIT: scan the whole project (~180k rows) to stress streaming under realistic volume.
const SQL = `SELECT id, project_id, trace_id, type, name, start_time, end_time,
                    provided_model_name, level, total_cost
             FROM observations
             WHERE project_id = '${projectId}'`;

function fmtBytes(b) {
  return (b / 1024 / 1024).toFixed(1) + " MB";
}

function snapshotHeap(label) {
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  return { label, heapUsed: m.heapUsed, rss: m.rss, ts: Date.now() };
}

function diffHeap(a, b) {
  return {
    heapDeltaMB: ((b.heapUsed - a.heapUsed) / 1024 / 1024).toFixed(1),
    rssDeltaMB: ((b.rss - a.rss) / 1024 / 1024).toFixed(1),
    elapsedMs: b.ts - a.ts,
  };
}

async function bufferedRead() {
  console.log("\n=== MODE A: buffered (await pool.query) ===");
  const conn = await mysql.createConnection(config);
  const before = snapshotHeap("before");
  const t0 = Date.now();

  const [rows] = await conn.query(SQL);

  const firstRowMs = Date.now() - t0; // entire query is one event for buffered
  const after = snapshotHeap("after");
  const totalMs = Date.now() - t0;

  console.log(`rows: ${rows.length}`);
  console.log(`time-to-first-row (= time-to-all-rows): ${firstRowMs} ms`);
  console.log(`total time: ${totalMs} ms`);
  console.log(
    `heap before: ${fmtBytes(before.heapUsed)}  after: ${fmtBytes(after.heapUsed)}  delta: ${diffHeap(before, after).heapDeltaMB} MB`,
  );
  console.log(
    `rss before: ${fmtBytes(before.rss)}  after: ${fmtBytes(after.rss)}  delta: ${diffHeap(before, after).rssDeltaMB} MB`,
  );

  await conn.end();
  // help GC for next mode
  return rows.length;
}

async function streamedRead() {
  console.log("\n=== MODE B: streamed (conn.query(sql).stream()) ===");

  // Use callback API to access .stream() — promise wrapper hides it.
  const conn = mysqlCallback.createConnection(config);

  await new Promise((resolve, reject) =>
    conn.connect((err) => (err ? reject(err) : resolve())),
  );

  const before = snapshotHeap("before");
  const t0 = Date.now();
  let firstRowMs = null;
  let count = 0;
  let peakHeap = before.heapUsed;
  let peakRss = before.rss;
  const sampleEvery = 10000;

  await new Promise((resolve, reject) => {
    const stream = conn.query(SQL).stream({ highWaterMark: 1000 });

    stream.on("data", (row) => {
      count++;
      if (firstRowMs == null) firstRowMs = Date.now() - t0;
      if (count % sampleEvery === 0) {
        const m = process.memoryUsage();
        if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
        if (m.rss > peakRss) peakRss = m.rss;
        console.log(
          `  @${count}: +${Date.now() - t0}ms  heap=${fmtBytes(m.heapUsed)}  rss=${fmtBytes(m.rss)}`,
        );
      }
      // simulate downstream work being light, so we don't artificially backpressure
    });

    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const after = snapshotHeap("after");
  const totalMs = Date.now() - t0;

  console.log(`rows: ${count}`);
  console.log(`time-to-first-row: ${firstRowMs} ms`);
  console.log(`total time: ${totalMs} ms`);
  console.log(
    `heap before: ${fmtBytes(before.heapUsed)}  peak: ${fmtBytes(peakHeap)}  after: ${fmtBytes(after.heapUsed)}`,
  );
  console.log(
    `rss  before: ${fmtBytes(before.rss)}  peak: ${fmtBytes(peakRss)}  after: ${fmtBytes(after.rss)}`,
  );

  await new Promise((resolve) => conn.end(() => resolve()));
  return count;
}

async function streamedAbort() {
  console.log(
    "\n=== MODE C: streamed + early abort (take 100 rows then destroy) ===",
  );
  const conn = mysqlCallback.createConnection(config);
  await new Promise((resolve, reject) =>
    conn.connect((err) => (err ? reject(err) : resolve())),
  );

  const t0 = Date.now();
  let firstRowMs = null;
  let count = 0;
  await new Promise((resolve, reject) => {
    const stream = conn.query(SQL).stream({ highWaterMark: 1000 });
    stream.on("data", (row) => {
      count++;
      if (firstRowMs == null) firstRowMs = Date.now() - t0;
      if (count >= 100) {
        stream.destroy();
        resolve();
      }
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  console.log(`took ${count} rows`);
  console.log(`time-to-first-row: ${firstRowMs} ms`);
  console.log(`time to abort: ${Date.now() - t0} ms`);

  await new Promise((resolve) => conn.end(() => resolve()));
}

(async () => {
  console.log(
    "Doris:",
    `${config.host}:${config.port}`,
    "db:",
    config.database,
  );
  console.log("project_id:", projectId);
  console.log("SQL:", SQL.replace(/\s+/g, " ").trim());

  try {
    await bufferedRead();
  } catch (e) {
    console.error("buffered failed:", e.message);
  }
  try {
    await streamedRead();
  } catch (e) {
    console.error("streamed failed:", e.message);
  }
  try {
    await streamedAbort();
  } catch (e) {
    console.error("abort failed:", e.message);
  }

  process.exit(0);
})();
