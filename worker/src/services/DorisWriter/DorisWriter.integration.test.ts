import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { DorisClient } from "@langfuse/shared/src/server";
import { env as sharedEnv } from "@langfuse/shared/src/env";
import { DorisWriter, TableName } from "./index";

const TEST_DB = "litefuse_writer_test";

describe("DorisWriter Integration Tests", () => {
  let dorisClient: DorisClient;
  let writer: DorisWriter;

  beforeAll(async () => {
    const adminClient = new DorisClient({
      feHttpUrl: sharedEnv.DORIS_FE_HTTP_URL,
      feQueryPort: sharedEnv.DORIS_FE_QUERY_PORT,
      database: "information_schema",
      username: sharedEnv.DORIS_USER,
      password: sharedEnv.DORIS_PASSWORD ?? "",
      timeout: 30000,
    });

    try {
      await adminClient.query(`CREATE DATABASE IF NOT EXISTS \`${TEST_DB}\``);
    } finally {
      await adminClient.close();
    }

    dorisClient = new DorisClient({
      feHttpUrl: sharedEnv.DORIS_FE_HTTP_URL,
      feQueryPort: sharedEnv.DORIS_FE_QUERY_PORT,
      database: TEST_DB,
      username: sharedEnv.DORIS_USER,
      password: sharedEnv.DORIS_PASSWORD ?? "",
      timeout: 30000,
    });

    await createTestTables();
  }, 30000);

  afterAll(async () => {
    if (dorisClient) {
      await dorisClient.close();
    }
  });

  beforeEach(() => {
    (DorisWriter as any).instance = null;
    writer = DorisWriter.getInstance(dorisClient);
  });

  afterEach(async () => {
    try {
      await dorisClient.query("TRUNCATE TABLE traces");
      await dorisClient.query("TRUNCATE TABLE scores");
      await dorisClient.query(`TRUNCATE TABLE ${TableName.Observations}`);
    } catch (error) {
      console.warn("Failed to truncate writer test tables:", error);
    }

    await writer.shutdown();
    (DorisWriter as any).instance = null;
  });

  async function createTestTables() {
    const tables = [
      {
        name: "traces",
        sql: `
          CREATE TABLE IF NOT EXISTS traces (
            id VARCHAR(255) NOT NULL,
            name VARCHAR(255),
            metadata Map<String, String>,
            tags ARRAY<VARCHAR(255)>,
            timestamp DateTime(3),
            timestamp_date Date,
            public BOOLEAN,
            bookmarked BOOLEAN,
            environment VARCHAR(255),
            project_id VARCHAR(255),
            is_deleted TINYINT,
            created_at DateTime(3),
            updated_at DateTime(3),
            event_ts DateTime(3)
          )
          DUPLICATE KEY(id)
          DISTRIBUTED BY HASH(id) BUCKETS 1
          PROPERTIES (
            "replication_allocation" = "tag.location.default: 1"
          )
        `,
      },
      {
        name: "scores",
        sql: `
          CREATE TABLE IF NOT EXISTS scores (
            id VARCHAR(255) NOT NULL,
            name VARCHAR(255),
            metadata Map<String, String>,
            timestamp DateTime(3),
            timestamp_date Date,
            source VARCHAR(255),
            environment VARCHAR(255),
            project_id VARCHAR(255),
            is_deleted TINYINT,
            created_at DateTime(3),
            updated_at DateTime(3),
            event_ts DateTime(3),
            value DOUBLE,
            data_type VARCHAR(50),
            trace_id VARCHAR(255)
          )
          DUPLICATE KEY(id)
          DISTRIBUTED BY HASH(id) BUCKETS 1
          PROPERTIES (
            "replication_allocation" = "tag.location.default: 1"
          )
        `,
      },
      {
        name: TableName.Observations,
        sql: `
          CREATE TABLE IF NOT EXISTS ${TableName.Observations} (
            id VARCHAR(255) NOT NULL,
            name VARCHAR(255),
            type VARCHAR(50),
            metadata Map<String, String>,
            environment VARCHAR(255),
            project_id VARCHAR(255),
            is_deleted TINYINT,
            created_at DateTime(3),
            updated_at DateTime(3),
            start_time DateTime(3),
            start_time_date Date,
            event_ts DateTime(3),
            trace_id VARCHAR(255),
            provided_usage_details Map<String, BIGINT>,
            provided_cost_details Map<String, Decimal(38, 12)>,
            usage_details Map<String, BIGINT>,
            cost_details Map<String, Decimal(38, 12)>
          )
          DUPLICATE KEY(id)
          DISTRIBUTED BY HASH(id) BUCKETS 1
          PROPERTIES (
            "replication_allocation" = "tag.location.default: 1"
          )
        `,
      },
    ];

    for (const table of tables) {
      await dorisClient.query(table.sql);
    }
  }

  it("should connect to Doris and verify basic operations", async () => {
    const isHealthy = await dorisClient.healthCheck();
    expect(isHealthy).toBe(true);

    const result = await dorisClient.query("SELECT 1 as test_value");
    expect(result).toHaveLength(1);
    expect(result[0].test_value).toBe(1);

    const tables = await dorisClient.query("SHOW TABLES");
    const tableNames = tables.map((row: any) => Object.values(row)[0]);
    expect(tableNames).toContain("traces");
    expect(tableNames).toContain("scores");
    expect(tableNames).toContain(TableName.Observations);
  });

  it("should write and read trace data", async () => {
    const traceData = {
      id: "test-trace-1",
      name: "Test Trace",
      metadata: { test: "value" },
      tags: ["test"],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "test-project",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    };

    // 写入数据
    writer.addToQueue(TableName.Traces, traceData);
    await writer.forceFlushAll(true);
    console.log("✓ Trace 数据已写入");

    // 等待数据同步
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 验证数据是否写入成功
    const result = await dorisClient.query(
      "SELECT * FROM traces WHERE id = ?",
      [traceData.id],
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(traceData.id);
    expect(result[0].name).toBe(traceData.name);
    console.log("✓ Trace 数据查询验证成功");
  });

  it("should write and read score data", async () => {
    const scoreData = {
      id: "test-score-1",
      name: "Test Score",
      metadata: { test: "value" },
      timestamp: Date.now(),
      source: "test",
      environment: "test",
      project_id: "test-project",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
      value: 0.8,
      data_type: "NUMERIC" as const,
      trace_id: "test-trace-1",
    };

    // 写入数据
    writer.addToQueue(TableName.Scores, scoreData);
    await writer.forceFlushAll(true);
    console.log("✓ Score 数据已写入");

    // 等待数据同步
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 验证数据是否写入成功
    const result = await dorisClient.query(
      "SELECT * FROM scores WHERE id = ?",
      [scoreData.id],
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(scoreData.id);
    expect(result[0].value).toBe(scoreData.value);
    expect(result[0].data_type).toBe(scoreData.data_type);
    console.log("✓ Score 数据查询验证成功");
  });

  it("should write and read observation data", async () => {
    const observationData = {
      id: "test-observation-1",
      name: "Test Observation",
      type: "GENERATION",
      metadata: { test: "value" },
      environment: "test",
      project_id: "test-project",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      start_time: Date.now(),
      event_ts: Date.now(),
      trace_id: "test-trace-1",
      provided_usage_details: {},
      provided_cost_details: {},
      usage_details: {},
      cost_details: {},
    };

    // 写入数据
    writer.addToQueue(TableName.Observations, observationData);
    await writer.forceFlushAll(true);
    console.log("✓ Observation 数据已写入");

    // 等待数据同步
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 验证数据是否写入成功
    const result = await dorisClient.query(
      `SELECT * FROM ${TableName.Observations} WHERE id = ?`,
      [observationData.id],
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(observationData.id);
    expect(result[0].type).toBe(observationData.type);
    console.log("✓ Observation 数据查询验证成功");
  });

  it("should handle batch writes correctly", async () => {
    const batchSize = 5; // 减少批量大小以便测试
    const traces = Array.from({ length: batchSize }, (_, i) => ({
      id: `test-trace-batch-${i}`,
      name: `Test Trace ${i}`,
      metadata: { index: String(i) },
      tags: ["test", "batch"],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "test-project",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    }));

    // 批量写入数据
    for (const trace of traces) {
      writer.addToQueue(TableName.Traces, trace);
    }
    await writer.forceFlushAll(true);
    console.log(`✓ 批量写入 ${batchSize} 条 Trace 数据`);

    // 等待数据同步
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 验证所有数据是否写入成功
    const result = await dorisClient.query(
      "SELECT COUNT(*) as count FROM traces WHERE id LIKE 'test-trace-batch-%'",
    );

    expect(result[0].count).toBe(batchSize);
    console.log("✓ 批量数据查询验证成功");
  });

  it("should handle concurrent writes", async () => {
    const concurrentWrites = 3; // 减少并发数量以便测试
    const writePromises = Array.from({ length: concurrentWrites }, (_, i) => {
      const trace = {
        id: `concurrent-trace-${i}`,
        name: `Concurrent Trace ${i}`,
        metadata: { index: String(i) },
        tags: ["test", "concurrent"],
        timestamp: Date.now(),
        public: false,
        bookmarked: false,
        environment: "test",
        project_id: "test-project",
        is_deleted: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        event_ts: Date.now(),
      };
      return writer.addToQueue(TableName.Traces, trace);
    });

    // 等待所有写入完成
    await Promise.all(writePromises);
    await writer.forceFlushAll(true);
    console.log(`✓ 并发写入 ${concurrentWrites} 条数据`);

    // 等待数据同步
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 验证所有数据是否写入成功
    const result = await dorisClient.query(
      "SELECT COUNT(*) as count FROM traces WHERE id LIKE 'concurrent-trace-%'",
    );

    expect(result[0].count).toBe(concurrentWrites);
    console.log("✓ 并发数据查询验证成功");
  });
});
