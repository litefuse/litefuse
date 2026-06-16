/**
 * Test for verifying row_limit works correctly in Doris backend
 *
 * Run with:
 *   pnpm test -- --testPathPatterns="queryBuilder-doris-row-limit" --testNamePattern="row_limit"
 */

import { QueryBuilder } from "../../features/query/server/queryBuilder";
import { env } from "../../env.mjs";
import mysql from "mysql2/promise";

const TEST_DB = "langfuse_row_limit_test";
const PROJECT_ID = "test-project-row-limit";

describe("QueryBuilder Doris row_limit", () => {
  let mainPool: mysql.Pool;

  beforeAll(async () => {
    // Setup database connection
    const url = new URL(env.DORIS_FE_HTTP_URL);
    mainPool = mysql.createPool({
      host: url.hostname,
      port: env.DORIS_FE_QUERY_PORT,
      user: env.DORIS_USER || "root",
      password: env.DORIS_PASSWORD || "",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: "+00:00",
    });

    const connection = await mainPool.getConnection();

    try {
      // Drop and recreate test database
      await connection.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await connection.query(`CREATE DATABASE ${TEST_DB}`);
      console.log(`Created database: ${TEST_DB}`);
    } finally {
      connection.release();
    }

    // Create tables and insert data
    const testPool = mysql.createPool({
      host: url.hostname,
      port: env.DORIS_FE_QUERY_PORT,
      user: env.DORIS_USER || "root",
      password: env.DORIS_PASSWORD || "",
      database: TEST_DB,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: "+00:00",
    });

    const testConnection = await testPool.getConnection();

    try {
      // Create traces table - using DATETIME columns which is what DateTimeFilter expects
      await testConnection.query(`
        CREATE TABLE IF NOT EXISTS traces (
          id VARCHAR(255) NOT NULL,
          name VARCHAR(255),
          metadata JSON,
          tags ARRAY<VARCHAR(255)>,
          timestamp DATETIME(3),
          timestamp_date DATE,
          public BOOLEAN,
          bookmarked BOOLEAN,
          environment VARCHAR(255),
          project_id VARCHAR(255),
          is_deleted TINYINT,
          created_at DATETIME(3),
          updated_at DATETIME(3),
          event_ts DATETIME(3)
        )
        DUPLICATE KEY(id)
        DISTRIBUTED BY HASH(id) BUCKETS 1
        PROPERTIES (
          "replication_allocation" = "tag.location.default: 1"
        )
      `);
      console.log("Created traces table");

      // Create observations table
      await testConnection.query(`
        CREATE TABLE IF NOT EXISTS observations (
          id VARCHAR(255) NOT NULL,
          name VARCHAR(255),
          type VARCHAR(50),
          metadata JSON,
          environment VARCHAR(255),
          project_id VARCHAR(255),
          is_deleted TINYINT,
          created_at DATETIME(3),
          updated_at DATETIME(3),
          start_time DATETIME(3),
          start_time_date DATE,
          end_time DATETIME(3),
          event_ts DATETIME(3),
          trace_id VARCHAR(255),
          provided_usage_details JSON,
          provided_cost_details JSON,
          usage_details JSON,
          cost_details JSON,
          total_cost DOUBLE
        )
        DUPLICATE KEY(id)
        DISTRIBUTED BY HASH(id) BUCKETS 1
        PROPERTIES (
          "replication_allocation" = "tag.location.default: 1"
        )
      `);
      console.log("Created observations table");

      // Insert mock trace data
      console.log("Inserting mock trace data...");
      const traceNames = [
        "chat/completion",
        "embedding/create",
        "image/generate",
        "audio/transcribe",
        "moderation/check",
        "text/edit",
        "text/search",
        "file/upload",
        "file/download",
        "video/generate",
      ];

      const baseTime = new Date("2026-03-15T12:00:00.000Z");

      for (let i = 0; i < 30; i++) {
        const timestamp = new Date(baseTime.getTime() + i * 3600000);
        const traceId = `trace-${String(i).padStart(3, "0")}`;
        await testConnection.query(
          `INSERT INTO traces (id, name, project_id, timestamp, timestamp_date, environment, created_at, updated_at, event_ts, is_deleted, metadata, public, bookmarked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            traceId,
            traceNames[i % traceNames.length],
            PROJECT_ID,
            timestamp.toISOString().slice(0, 19).replace("T", " "),
            timestamp.toISOString().slice(0, 10),
            "development",
            timestamp.toISOString().slice(0, 19).replace("T", " "),
            timestamp.toISOString().slice(0, 19).replace("T", " "),
            timestamp.toISOString().slice(0, 19).replace("T", " "),
            0,
            "{}",
            false,
            false,
          ],
        );
      }
      console.log("Inserted 30 traces");

      // Insert mock observation data
      console.log("Inserting mock observation data...");
      let obsCount = 0;
      for (let i = 0; i < 30; i++) {
        const traceId = `trace-${String(i).padStart(3, "0")}`;
        const numObs = (i % 3) + 1;
        const traceTime = new Date(baseTime.getTime() + i * 3600000);

        for (let j = 0; j < numObs; j++) {
          const startTime = new Date(traceTime.getTime() + j * 1000);
          const endTime = new Date(startTime.getTime() + 100 + j * 50);
          await testConnection.query(
            `INSERT INTO observations (id, trace_id, name, project_id, start_time, start_time_date, end_time, environment, created_at, updated_at, event_ts, is_deleted, metadata, total_cost, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              `obs-${String(obsCount).padStart(4, "0")}`,
              traceId,
              `observation-${j}`,
              PROJECT_ID,
              startTime.toISOString().slice(0, 19).replace("T", " "),
              startTime.toISOString().slice(0, 10),
              endTime.toISOString().slice(0, 19).replace("T", " "),
              "development",
              startTime.toISOString().slice(0, 19).replace("T", " "),
              startTime.toISOString().slice(0, 19).replace("T", " "),
              startTime.toISOString().slice(0, 19).replace("T", " "),
              0,
              "{}",
              Math.random() * 0.5,
              "GENERATION",
            ],
          );
          obsCount++;
        }
      }
      console.log(`Inserted ${obsCount} observations`);

      // Verify counts
      const [traceRows] = await testConnection.query(
        "SELECT COUNT(*) as cnt FROM traces",
      );
      const [obsRows] = await testConnection.query(
        "SELECT COUNT(*) as cnt FROM observations",
      );
      console.log(
        `Verification: ${(traceRows as any)[0].cnt} traces, ${(obsRows as any)[0].cnt} observations`,
      );
    } finally {
      testConnection.release();
      await testPool.end();
    }
  }, 120000);

  afterAll(async () => {
    if (mainPool) {
      const connection = await mainPool.getConnection();
      try {
        await connection.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
        console.log(`Dropped database: ${TEST_DB}`);
      } finally {
        connection.release();
        await mainPool.end();
      }
    }
  });

  it("should apply LIMIT clause with row_limit = 5", async () => {
    const query = {
      view: "traces" as const,
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "totalCost", aggregation: "sum" as const }],
      filters: [],
      rawSqlFilter: null,
      timeDimension: null,
      fromTimestamp: "2026-03-01T00:00:00.000Z",
      toTimestamp: "2026-04-01T00:00:00.000Z",
      orderBy: null,
      chartConfig: {
        type: "VERTICAL_BAR" as const,
        row_limit: 5,
      },
    };

    const queryBuilder = new QueryBuilder(query.chartConfig, "v1");
    const { query: sql, parameters } = await queryBuilder.build(
      query,
      PROJECT_ID,
      false,
    );

    console.log("Generated SQL:\n" + sql);

    // Execute the query
    const url = new URL(env.DORIS_FE_HTTP_URL);
    const execPool = mysql.createPool({
      host: url.hostname,
      port: env.DORIS_FE_QUERY_PORT,
      user: env.DORIS_USER || "root",
      password: env.DORIS_PASSWORD || "",
      database: TEST_DB,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      timezone: "+00:00",
    });

    try {
      // Replace parameters
      let finalSql = sql;
      Object.entries(parameters).forEach(([key, value]) => {
        finalSql = finalSql.replace(
          new RegExp(`\\{${key}:[^}]+\\}`, "g"),
          String(value),
        );
      });

      console.log("Final SQL:\n" + finalSql);

      const [rows] = await execPool.query(finalSql);
      console.log(`Result: ${(rows as any).length} rows returned`);
      console.log("Data:", JSON.stringify(rows, null, 2));

      expect((rows as any).length).toBeLessThanOrEqual(5);
    } finally {
      await execPool.end();
    }
  }, 60000);

  it("should apply LIMIT clause with row_limit = 10", async () => {
    const query = {
      view: "traces" as const,
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "totalCost", aggregation: "sum" as const }],
      filters: [],
      rawSqlFilter: null,
      timeDimension: null,
      fromTimestamp: "2026-03-01T00:00:00.000Z",
      toTimestamp: "2026-04-01T00:00:00.000Z",
      orderBy: null,
      chartConfig: {
        type: "VERTICAL_BAR" as const,
        row_limit: 10,
      },
    };

    const queryBuilder = new QueryBuilder(query.chartConfig, "v1");
    const { query: sql, parameters } = await queryBuilder.build(
      query,
      PROJECT_ID,
      false,
    );

    console.log("Generated SQL:\n" + sql);

    // Execute the query
    const url = new URL(env.DORIS_FE_HTTP_URL);
    const execPool = mysql.createPool({
      host: url.hostname,
      port: env.DORIS_FE_QUERY_PORT,
      user: env.DORIS_USER || "root",
      password: env.DORIS_PASSWORD || "",
      database: TEST_DB,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      timezone: "+00:00",
    });

    try {
      // Replace parameters
      let finalSql = sql;
      Object.entries(parameters).forEach(([key, value]) => {
        finalSql = finalSql.replace(
          new RegExp(`\\{${key}:[^}]+\\}`, "g"),
          String(value),
        );
      });

      console.log("Final SQL:\n" + finalSql);

      const [rows] = await execPool.query(finalSql);
      console.log(`Result: ${(rows as any).length} rows returned`);
      console.log("Data:", JSON.stringify(rows, null, 2));

      expect((rows as any).length).toBeLessThanOrEqual(10);
    } finally {
      await execPool.end();
    }
  }, 60000);

  it("should apply raw SQL LIMIT correctly", async () => {
    // Verify raw SQL with LIMIT works
    const url = new URL(env.DORIS_FE_HTTP_URL);
    const execPool = mysql.createPool({
      host: url.hostname,
      port: env.DORIS_FE_QUERY_PORT,
      user: env.DORIS_USER || "root",
      password: env.DORIS_PASSWORD || "",
      database: TEST_DB,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      timezone: "+00:00",
    });

    try {
      const [rows] = await execPool.query(`
        SELECT name, count(*) as cnt
        FROM traces
        WHERE timestamp >= '2026-03-01 00:00:00.000' AND timestamp < '2026-04-01 00:00:00.000'
        GROUP BY name
        LIMIT 5
      `);

      console.log(
        `Raw SQL with LIMIT 5: ${(rows as any).length} rows returned`,
      );
      console.log("Data:", JSON.stringify(rows, null, 2));
      expect((rows as any).length).toBeLessThanOrEqual(5);
    } finally {
      await execPool.end();
    }
  }, 60000);
});
