/* eslint-disable */
// Verify that mysql2/promise pool exposes underlying .stream() the way our
// DorisClient pool would. This mirrors the exact API path queryDorisStream
// will take after the refactor.

const path = require("path");
const mysql = require(
  path.join(__dirname, "..", "packages/shared/node_modules/mysql2/promise"),
);

const config = {
  host: "127.0.0.1",
  port: 41930,
  user: "root",
  password: "",
  database: "langfuse",
  waitForConnections: true,
  connectionLimit: 4,
  queueLimit: 0,
  timezone: "+00:00",
};

async function main() {
  const pool = mysql.createPool(config);
  const projectId = "cmohzoe670006z407sgvdpn72";
  const sql = `SELECT id, project_id, type, name, start_time
               FROM observations
               WHERE project_id = '${projectId}'
               LIMIT 5000`;

  // Acquire a connection from the promise pool
  const conn = await pool.getConnection();
  const t0 = Date.now();
  let count = 0;
  let firstRowMs = null;

  try {
    // Promise wrapper exposes the underlying callback-style connection at .connection
    const stream = conn.connection.query(sql).stream({ highWaterMark: 1000 });

    for await (const row of stream) {
      count++;
      if (firstRowMs == null) firstRowMs = Date.now() - t0;
    }
  } finally {
    conn.release();
  }

  console.log(
    `pool-stream rows=${count} first=${firstRowMs}ms total=${Date.now() - t0}ms`,
  );

  // Make sure the connection is released back to the pool: borrow another and reuse
  const conn2 = await pool.getConnection();
  const [r] = await conn2.query("SELECT 1 as ok");
  conn2.release();
  console.log("pool reuse ok:", r);

  await pool.end();
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
