import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as serverExports from "@langfuse/shared/src/server";

import { env } from "../../env";
import { logger } from "@langfuse/shared/src/server";
import { DorisWriter, TableName } from "./index";

// Mock recordHistogram, recordCount, recordGauge
vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const original = (await importOriginal()) as {};
  return {
    ...original,
    recordHistogram: vi.fn(),
    recordIncrement: vi.fn(),
    recordGauge: vi.fn(),
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock("../../env", async (importOriginal) => {
  const original = (await importOriginal()) as {};
  return {
    ...original,
    env: {
      LITEFUSE_INGESTION_DORIS_WRITE_BATCH_SIZE: 100,
      LITEFUSE_INGESTION_DORIS_WRITE_INTERVAL_MS: 5000,
      LITEFUSE_INGESTION_DORIS_MAX_ATTEMPTS: 3,
      LITEFUSE_INGESTION_DORIS_MAX_CONCURRENT_LOADS: 8,
      LITEFUSE_INGESTION_DORIS_MAX_QUEUE_SIZE_BYTES: 100 * 1024 * 1024,
      LITEFUSE_INGESTION_DORIS_MAX_BATCH_SIZE_BYTES: 64 * 1024 * 1024,
      LITEFUSE_INGESTION_DORIS_GAUGE_INTERVAL_MS: 10000,
      // Backoff base == max == writeInterval so a parked retry becomes due
      // exactly one advanceTimersByTimeAsync(writeInterval) tick later — the
      // timing-based retry tests below can then step one attempt per tick. A
      // dedicated test overrides these on the instance to exercise real backoff.
      LITEFUSE_INGESTION_DORIS_RETRY_BACKOFF_BASE_MS: 5000,
      LITEFUSE_INGESTION_DORIS_RETRY_BACKOFF_MAX_MS: 5000,
    },
  };
});

// insert() receives a StreamLoadBodySource (chunked body) from the writer;
// materialize it back into the exact wire string for assertions.
const bodyToString = (body: any): string =>
  typeof body === "string"
    ? body
    : Buffer.concat([...body.chunks()]).toString("utf8");

const dorisClientMock = {
  insert: vi.fn(),
  streamLoad: vi.fn(),
  query: vi.fn(),
  queryWithParams: vi.fn(),
  healthCheck: vi.fn(),
  getDatabaseInfo: vi.fn(),
  close: vi.fn(),
  httpClient: {} as any,
  config: {} as any,
  connectionPool: {} as any,
  initializeConnectionPool: vi.fn(),
} as any;

describe("DorisWriter", () => {
  let writer: DorisWriter;

  // A table's buffered row array (queue internals), for the assertions below.
  const q = (t: TableName): any[] => (writer as any).queue[t];
  // A table's parked failed-batch entries (retry buffer internals).
  const retryEntries = (t: TableName): any[] => (writer as any).retryBuffer[t];
  // Total rows still owned by the writer for a table: fresh queue + parked
  // retries (each retry entry holds a whole batch of rows).
  const ownedRows = (t: TableName): number =>
    q(t).length +
    retryEntries(t).reduce((s: number, e: any) => s + e.items.length, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    writer = DorisWriter.getInstance(dorisClientMock);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();

    // Reset singleton instance
    await writer.shutdown();
    (DorisWriter as any).instance = null;
  });

  it("should be a singleton", () => {
    const instance1 = DorisWriter.getInstance();
    const instance2 = DorisWriter.getInstance();

    expect(instance1).toBe(instance2);
  });

  it("should initialize with correct values", () => {
    expect(writer.batchSize).toBe(
      env.LITEFUSE_INGESTION_DORIS_WRITE_BATCH_SIZE,
    );
    expect(writer.writeInterval).toBe(
      env.LITEFUSE_INGESTION_DORIS_WRITE_INTERVAL_MS,
    );
    // maxAttempts is sourced from the SHARED env (@langfuse/shared/src/env),
    // not the worker env mocked here, so we only assert it's a valid number.
    // Its retry semantics are covered by the finite/infinite tests below.
    expect(typeof writer.maxAttempts).toBe("number");
  });

  it("should add items to the queue", () => {
    const traceData = {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any;

    writer.addToQueue(TableName.Traces, traceData);

    expect(q(TableName.Traces)).toHaveLength(1);
    // Rows are stored as their serialized UTF-8 bytes, not the source object.
    expect(JSON.parse(q(TableName.Traces)[0].buf.toString("utf8")).id).toBe(
      "1",
    );
  });

  it("should flush when queue reaches batch size", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);

    for (let i = 0; i < writer.batchSize; i++) {
      writer.addToQueue(TableName.Traces, {
        id: `${i}`,
        name: "test",
        metadata: {},
        tags: [],
        timestamp: Date.now(),
        public: false,
        bookmarked: false,
        environment: "test",
        project_id: "project1",
        is_deleted: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        event_ts: Date.now(),
      } as any);
    }

    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(q(TableName.Traces)).toHaveLength(0);
  });

  it("should flush at regular intervals", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("should handle errors and retry", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockRejectedValueOnce(new Error("DB Error"))
      .mockResolvedValueOnce(undefined);

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    // First attempt failed → the batch is parked in the retry buffer (not back
    // in the fresh queue) as one entry with attempts=1. The writer's failure
    // signal is the parkForRetry warn carrying the cause (the detailed
    // error-level line is the client's, which is mocked out here).
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("DB Error"),
    );
    expect(q(TableName.Traces)).toHaveLength(0);
    expect(retryEntries(TableName.Traces)).toHaveLength(1);
    expect(retryEntries(TableName.Traces)[0].attempts).toBe(1);
    expect(retryEntries(TableName.Traces)[0].items).toHaveLength(1);

    // The retry fires off its own precise backoff timer (base ~1ms in the mock
    // env), independent of writeInterval; the second attempt succeeds and the
    // entry is gone.
    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(retryEntries(TableName.Traces)).toHaveLength(0);
    expect(q(TableName.Traces)).toHaveLength(0);
  });

  it("should drop records after max attempts (finite mode)", async () => {
    writer.maxAttempts = 3; // finite; default is 0 = infinite (never drop)
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockRejectedValue(new Error("DB Error"));

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    // One attempt per tick: first (staleness) attempt + (maxAttempts-1) retries.
    for (let i = 0; i < writer.maxAttempts + 1; i++) {
      await vi.advanceTimersByTimeAsync(writer.writeInterval);
    }

    expect(mockInsert).toHaveBeenCalledTimes(writer.maxAttempts);
    expect(
      (logger.error as any).mock.calls.some(
        (call: any) =>
          String(call[0]).includes("Max attempts") &&
          String(call[0]).includes("Dropping"),
      ),
    ).toBe(true);
    // Dropped from both fresh queue and retry buffer.
    expect(q(TableName.Traces)).toHaveLength(0);
    expect(retryEntries(TableName.Traces)).toHaveLength(0);
  });

  it("retries forever without dropping when maxAttempts <= 0 (infinite, the default)", async () => {
    writer.maxAttempts = 0; // infinite — never drop
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockRejectedValue(new Error("DB Error"));

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(writer.writeInterval);
    }

    // Kept retrying every tick, the batch is still parked (one entry, one row),
    // its attempts climbed past any finite cap, and it was never dropped.
    expect(mockInsert.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(q(TableName.Traces)).toHaveLength(0);
    expect(retryEntries(TableName.Traces)).toHaveLength(1);
    expect(retryEntries(TableName.Traces)[0].attempts).toBeGreaterThan(3);
    expect(ownedRows(TableName.Traces)).toBe(1);
    expect(
      (logger.error as any).mock.calls.some((call: any) =>
        String(call[0]).includes("Dropping"),
      ),
    ).toBe(false);
  });

  it("backs off a failed batch on its own timer, without blocking fresh rows on the same table", async () => {
    writer.maxAttempts = 0; // infinite — isolate backoff from dropping
    // Long backoff so the poison batch is observably not retried for a while;
    // its wait lives on the precise retry timer, not the writeInterval tick.
    writer.retryBackoffBaseMs = 100 * writer.writeInterval;
    writer.retryBackoffMaxMs = 1000 * writer.writeInterval;

    const trace = (id: string) =>
      ({
        id,
        name: id,
        metadata: {},
        tags: [],
        timestamp: Date.now(),
        public: false,
        bookmarked: false,
        environment: "test",
        project_id: "project1",
        is_deleted: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        event_ts: Date.now(),
      }) as any;

    // Fail only the batch carrying the poison row; every other batch succeeds.
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockImplementation(async (_t: any, body: any) => {
        if (bodyToString(body).includes("poison")) throw new Error("DB Error");
        return undefined as any;
      });
    const poisonCalls = () =>
      mockInsert.mock.calls.filter((c: any) =>
        bodyToString(c[1]).includes("poison"),
      ).length;
    const goodCalls = () =>
      mockInsert.mock.calls.filter((c: any) =>
        bodyToString(c[1]).includes("good"),
      ).length;

    // Park the poison batch: one attempt fails, it lands in the retry buffer.
    writer.addToQueue(TableName.Traces, trace("poison"));
    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    expect(poisonCalls()).toBe(1);
    expect(retryEntries(TableName.Traces)).toHaveLength(1);

    // Many ticks within the backoff window: poison is NOT retried (its timer is
    // far in the future), yet fresh rows on the SAME table flow through and get
    // written — the backoff never occupies the table or a concurrency slot.
    writer.addToQueue(TableName.Traces, trace("good"));
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(writer.writeInterval);
    }
    expect(poisonCalls()).toBe(1); // still not retried
    expect(goodCalls()).toBeGreaterThanOrEqual(1); // fresh flowed
    expect(q(TableName.Traces)).toHaveLength(0); // fresh drained, not blocked
    expect(retryEntries(TableName.Traces)).toHaveLength(1); // poison still parked

    // Once the backoff window elapses the poison batch retries (still fails,
    // re-parks, never dropped in infinite mode).
    await vi.advanceTimersByTimeAsync(writer.retryBackoffBaseMs);
    expect(poisonCalls()).toBeGreaterThanOrEqual(2);
    expect(retryEntries(TableName.Traces)).toHaveLength(1);
  });

  it("should shutdown gracefully", async () => {
    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);

    await writer.shutdown();

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(writer["stalenessTimer"]).toBeNull();
    expect(logger.info).toHaveBeenCalledWith("DorisWriter shutdown complete.");
  });

  it("should handle multiple table types", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "trace",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    writer.addToQueue(TableName.Scores, {
      id: "2",
      name: "score",
      metadata: {},
      timestamp: Date.now(),
      source: "manual",
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
      value: 0.8,
      data_type: "NUMERIC",
      trace_id: "trace1",
    } as any);

    writer.addToQueue(TableName.Observations, {
      id: "3",
      name: "observation",
      type: "GENERATION",
      metadata: {},
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      start_time: Date.now(),
      event_ts: Date.now(),
      trace_id: "trace1",
      provided_usage_details: {},
      provided_cost_details: {},
      usage_details: {},
      cost_details: {},
    } as any);

    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    expect(mockInsert).toHaveBeenCalledTimes(3);
    expect(q(TableName.Traces)).toHaveLength(0);
    expect(q(TableName.Scores)).toHaveLength(0);
    expect(q(TableName.Observations)).toHaveLength(0);
  });

  it("does not flush a partial (< batchSize) batch until it is stale", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);

    await writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);
    await Promise.resolve();

    // 1 item is below batchSize and fresh → not "ready", so not flushed yet.
    expect(mockInsert).not.toHaveBeenCalled();
    expect(q(TableName.Traces)).toHaveLength(1);

    // After writeInterval it becomes stale → the staleness tick flushes it.
    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(q(TableName.Traces)).toHaveLength(0);
  });

  it("should set up interval correctly in start method", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    writer["start"]();

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      writer.writeInterval,
    );
  });

  it("should flush all queues when forceFlushAll is called directly", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "trace",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    writer.addToQueue(TableName.Scores, {
      id: "2",
      name: "score",
      metadata: {},
      timestamp: Date.now(),
      source: "manual",
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
      value: 0.8,
      data_type: "NUMERIC",
      trace_id: "trace1",
    } as any);

    await writer.forceFlushAll();

    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(q(TableName.Traces)).toHaveLength(0);
    expect(q(TableName.Scores)).toHaveLength(0);
  });

  it("should handle adding items to queue while flush is in progress", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockImplementation(() => {
        writer.addToQueue(TableName.Traces, {
          id: "2",
          name: "test2",
          metadata: {},
          tags: [],
          timestamp: Date.now(),
          public: false,
          bookmarked: false,
          environment: "test",
          project_id: "project1",
          is_deleted: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
          event_ts: Date.now(),
        } as any);
        return Promise.resolve();
      });

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test1",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(q(TableName.Traces)).toHaveLength(1);
    expect(JSON.parse(q(TableName.Traces)[0].buf.toString("utf8")).id).toBe(
      "2",
    );
  });

  it("should handle concurrent writes during high load", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);
    const concurrentWrites = 1000;

    const writes = Array.from({ length: concurrentWrites }, (_, i) =>
      writer.addToQueue(TableName.Traces, {
        id: `${i}`,
        name: `test${i}`,
        metadata: {},
        tags: [],
        timestamp: Date.now(),
        public: false,
        bookmarked: false,
        environment: "test",
        project_id: "project1",
        is_deleted: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        event_ts: Date.now(),
      } as any),
    );

    await Promise.all(writes);
    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    expect(mockInsert).toHaveBeenCalledTimes(
      Math.ceil(concurrentWrites / writer.batchSize),
    );
    expect(q(TableName.Traces).length).toBeLessThan(writer.batchSize);
  });

  it("should report wait time and processing time metrics correctly", async () => {
    const metricsDistributionSpy = vi.spyOn(serverExports, "recordHistogram");
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    expect(metricsDistributionSpy).toHaveBeenCalledWith(
      "langfuse.queue.doris_writer.wait_time",
      expect.any(Number),
      { unit: "milliseconds" },
    );

    expect(metricsDistributionSpy).toHaveBeenCalledWith(
      "langfuse.queue.doris_writer.processing_time",
      expect.any(Number),
      { unit: "milliseconds" },
    );
  });

  it("should handle different types of Doris client errors", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Timeout"))
      .mockResolvedValueOnce(undefined);

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    // Each failure surfaces its cause on the retry warn line (the detailed
    // error line belongs to the client, mocked out here).
    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Network error"),
    );

    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Timeout"),
    );

    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    expect(q(TableName.Traces)).toHaveLength(0);
  });

  it("should handle partial queue flush correctly", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);
    const partialQueueSize = Math.floor(writer.batchSize / 2);

    for (let i = 0; i < partialQueueSize; i++) {
      writer.addToQueue(TableName.Traces, {
        id: `${i}`,
        name: "test",
        metadata: {},
        tags: [],
        timestamp: Date.now(),
        public: false,
        bookmarked: false,
        environment: "test",
        project_id: "project1",
        is_deleted: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        event_ts: Date.now(),
      } as any);
    }

    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    // insert(table, body, recordCount, options): body is a chunked
    // StreamLoadBodySource whose materialized bytes form NDJSON — one row per
    // line, each line newline-terminated — carrying the "ndjson" format
    // discriminant (the client derives the body-shape flags from it), with an
    // exact byteLength, and recordCount matches the flushed rows.
    expect(mockInsert).toHaveBeenCalledWith(
      "traces",
      expect.objectContaining({
        format: "ndjson",
        byteLength: expect.any(Number),
        chunks: expect.any(Function),
      }),
      partialQueueSize,
      expect.any(Object),
    );
    const bodySource = (mockInsert.mock.calls[0] as any[])[1];
    const body = bodyToString(bodySource);
    expect(body.endsWith("\n")).toBe(true);
    const lines = body.slice(0, -1).split("\n");
    expect(lines).toHaveLength(partialQueueSize);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(bodySource.byteLength).toBe(Buffer.byteLength(body, "utf8"));
    expect(q(TableName.Traces)).toHaveLength(0);
  });

  it("should continue functioning after encountering an error", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockRejectedValueOnce(new Error("DB Error"))
      .mockResolvedValue(undefined);

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test1",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);
    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    writer.addToQueue(TableName.Traces, {
      id: "2",
      name: "test2",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);
    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    // 3 writes: item "1" fails and is parked; on the next tick it is retried as
    // its own intact batch (success) while the fresh item "2" flushes as a
    // separate batch — retried batches are never merged back into fresh rows.
    expect(mockInsert).toHaveBeenCalledTimes(3);
    expect(q(TableName.Traces)).toHaveLength(0);
    expect(retryEntries(TableName.Traces)).toHaveLength(0);
  });

  it("should handle BlobStorageFileLog table", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);

    writer.addToQueue(TableName.BlobStorageFileLog, {
      id: "1",
      project_id: "project1",
      blob_id: "blob1",
      bucket_name: "test-bucket",
      object_key: "test/file.txt",
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(q(TableName.BlobStorageFileLog)).toHaveLength(0);
  });

  it("should record correct metrics", async () => {
    const recordIncrementSpy = vi.spyOn(serverExports, "recordIncrement");
    const recordGaugeSpy = vi.spyOn(serverExports, "recordGauge");
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    await vi.advanceTimersByTimeAsync(writer.writeInterval);

    expect(recordIncrementSpy).toHaveBeenCalledWith(
      "langfuse.queue.doris_writer.request",
    );

    expect(recordGaugeSpy).toHaveBeenCalledWith(
      "ingestion_doris_insert_queue_length",
      0,
      {
        unit: "records",
        entityType: "traces",
      },
    );
  });

  it("should use forceFlushAll method", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);

    writer.addToQueue(TableName.Traces, {
      id: "1",
      name: "test",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    } as any);

    await writer.forceFlushAll();

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(q(TableName.Traces)).toHaveLength(0);
  });

  const mkTrace = (id: string) =>
    ({
      id,
      name: "t",
      metadata: {},
      tags: [],
      timestamp: Date.now(),
      public: false,
      bookmarked: false,
      environment: "test",
      project_id: "project1",
      is_deleted: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
    }) as any;

  it("caps concurrent in-flight stream loads at maxConcurrentLoads", async () => {
    // Loads never resolve → they hold their slot; extra flushes must be gated.
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockImplementation(() => new Promise<void>(() => {}));
    writer.maxConcurrentLoads = 2;

    // 3 batches worth of rows → 3 flushes triggered, but only 2 may run.
    for (let i = 0; i < 3 * writer.batchSize; i++) {
      void writer.addToQueue(TableName.Traces, mkTrace(String(i)));
    }
    await Promise.resolve();

    expect(mockInsert).toHaveBeenCalledTimes(2);
    // The 3rd batch stays queued (gated), not spliced into a load.
    expect(q(TableName.Traces).length).toBe(writer.batchSize);
  });

  it("applies backpressure: addToQueue blocks over maxQueueSizeBytes, releases once drained", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockImplementation(() => new Promise<void>(() => {})); // hang → no drain
    writer.maxConcurrentLoads = 0; // no drain worker can run
    writer.maxQueueSizeBytes = 1; // over cap after the first row

    await writer.addToQueue(TableName.Traces, mkTrace("0")); // queue empty → pushes

    let released = false;
    const blocked = writer
      .addToQueue(TableName.Traces, mkTrace("1"))
      .then(() => {
        released = true;
      });
    await vi.advanceTimersByTimeAsync(2 * writer.writeInterval);
    expect(released).toBe(false); // still blocked = backpressure active

    // Let a drain run and succeed → it removes the queued row, drops buffered
    // bytes below the cap, and wakes the backpressured producer.
    mockInsert.mockResolvedValue(undefined);
    writer.maxConcurrentLoads = 1;
    await vi.advanceTimersByTimeAsync(writer.writeInterval); // staleness tick → drain
    await blocked;
    expect(released).toBe(true);
  });

  it("pickReadyTable round-robins so no table (e.g. spans) is starved", () => {
    // Seed two tables (Traces = first in enum, Spans = last) each with a
    // stale (ready) row, bypassing addToQueue so nothing drains.
    const seed = (t: TableName) =>
      (writer as any).queue[t].push({
        createdAt: 0,
        buf: Buffer.from("{}\n"),
      });
    seed(TableName.Traces);
    seed(TableName.Spans);

    const pick = () => (writer as any).pickReadyTable(Date.now());
    const first = pick();
    const second = pick();

    // Fixed-order scan would return Traces twice; round-robin returns both.
    expect(first).not.toBe(second);
    expect(new Set([first, second])).toEqual(
      new Set([TableName.Traces, TableName.Spans]),
    );
  });

  it("caps batches by bytes (maxBatchBytes) and flushes on byte-fullness without waiting for row count", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockResolvedValue(undefined);
    const fatTrace = (id: string) =>
      ({ ...mkTrace(id), metadata: { pad: "x".repeat(1200) } }) as any;

    // First row while the cap is still huge — measure the real serialized size.
    await writer.addToQueue(TableName.Traces, fatTrace("0"));
    const rowBytes = q(TableName.Traces)[0].buf.length;
    expect(rowBytes).toBeGreaterThan(1200);
    // Cap at 2.5 rows: a batch fits exactly 2 rows; 3 buffered rows are
    // byte-full (and batchSize=100 rows is never reached).
    writer.maxBatchBytes = Math.floor(rowBytes * 2.5);

    await writer.addToQueue(TableName.Traces, fatTrace("1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockInsert).not.toHaveBeenCalled(); // 2 rows: under bytes, rows, staleness

    await writer.addToQueue(TableName.Traces, fatTrace("2"));
    await vi.advanceTimersByTimeAsync(0);
    // 3 buffered rows ≥ byte cap → flush-ready IMMEDIATELY (no staleness tick,
    // no full row count). The batch takes exactly 2 rows (a 3rd would exceed
    // maxBatchBytes) and the remainder stays queued.
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][2]).toBe(2); // recordCount
    expect(q(TableName.Traces)).toHaveLength(1);

    // The 1-row remainder is under every trigger → flushes on staleness.
    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(mockInsert.mock.calls[1][2]).toBe(1);
    expect(q(TableName.Traces)).toHaveLength(0);

    // A single row larger than the cap still ships — alone (rows can't split).
    writer.maxBatchBytes = 10;
    await writer.addToQueue(TableName.Traces, fatTrace("3"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockInsert).toHaveBeenCalledTimes(3);
    expect(mockInsert.mock.calls[2][2]).toBe(1);
    expect(q(TableName.Traces)).toHaveLength(0);
  });

  it("flushRemaining runs in pool-sized waves, never exceeding maxConcurrentLoads", async () => {
    let inFlight = 0;
    let peak = 0;
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => setTimeout(r, 10));
        inFlight--;
      });

    // Build up 5 full batches with the normal drain disabled, then flush.
    writer.maxConcurrentLoads = 0;
    for (let i = 0; i < 5 * writer.batchSize; i++) {
      await writer.addToQueue(TableName.Traces, mkTrace(String(i)));
    }
    expect(mockInsert).not.toHaveBeenCalled();

    writer.maxConcurrentLoads = 2;
    const flush = writer.forceFlushAll();
    for (let k = 0; k < 4; k++) {
      await vi.advanceTimersByTimeAsync(10); // release one 10ms wave at a time
    }
    await flush;

    expect(mockInsert).toHaveBeenCalledTimes(5);
    expect(peak).toBeLessThanOrEqual(2); // waves of maxConcurrentLoads, not all at once
    expect(q(TableName.Traces)).toHaveLength(0);
  });

  it("logs edge-triggered BACKPRESSURE engaged/released lines around a blocking episode", async () => {
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockImplementation(() => new Promise<void>(() => {})); // hang → no drain
    writer.maxConcurrentLoads = 0; // no drain worker can run
    writer.maxQueueSizeBytes = 1; // over cap after the first row

    await writer.addToQueue(TableName.Traces, mkTrace("0")); // queue empty → pushes

    const blocked = writer.addToQueue(TableName.Traces, mkTrace("1"));
    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    // First parked producer → exactly one ENGAGED warn (edge, not per wake).
    const engagedCalls = (logger.warn as any).mock.calls.filter((c: any) =>
      String(c[0]).includes("BACKPRESSURE engaged"),
    );
    expect(engagedCalls).toHaveLength(1);
    expect(engagedCalls[0][0]).toContain("traces");

    // Let a drain succeed → producer unblocks → one released info with stats.
    mockInsert.mockResolvedValue(undefined);
    writer.maxConcurrentLoads = 1;
    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    await blocked;
    const releasedCalls = (logger.info as any).mock.calls.filter((c: any) =>
      String(c[0]).includes("backpressure released"),
    );
    expect(releasedCalls).toHaveLength(1);
    expect(releasedCalls[0][0]).toMatch(
      /released after \d+(\.\d+)?s \(1 enqueues were blocked\)/,
    );
  });

  it("stable-label tables: the SAME label rides every retry of a batch; fresh batches get distinct labels; other tables get none", async () => {
    // Opt Traces into stable labels (in prod only AGGREGATE-KEY tables are in
    // the set — trace_metrics_agg).
    (writer as any).stableLabelTables = new Set([TableName.Traces]);
    const mockInsert = vi
      .spyOn(dorisClientMock, "insert")
      .mockRejectedValueOnce(new Error("DB Error")) // attempt 1 fails → parks
      .mockResolvedValue(undefined); // retry + everything after succeeds

    writer.addToQueue(TableName.Traces, mkTrace("1"));
    await vi.advanceTimersByTimeAsync(writer.writeInterval); // attempt 1
    await vi.advanceTimersByTimeAsync(writer.writeInterval); // retry (backoff = writeInterval in mock env)

    expect(mockInsert.mock.calls.length).toBeGreaterThanOrEqual(2);
    const label1 = (mockInsert.mock.calls[0][3] as any)?.label;
    const label2 = (mockInsert.mock.calls[1][3] as any)?.label;
    // Born at batch assembly, reused VERBATIM on the retry — the precondition
    // for FE label dedup (a regenerated label would break exactly-once).
    expect(label1).toMatch(/^langfuse_traces_\d+_[0-9a-f-]{36}$/);
    expect(label2).toBe(label1);

    // A NEW batch must get a NEW label.
    writer.addToQueue(TableName.Traces, mkTrace("2"));
    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    const label3 = (
      mockInsert.mock.calls[mockInsert.mock.calls.length - 1][3] as any
    )?.label;
    expect(label3).toMatch(/^langfuse_traces_\d+_[0-9a-f-]{36}$/);
    expect(label3).not.toBe(label1);

    // Non-opted-in tables carry no label (client self-generates per attempt).
    writer.addToQueue(TableName.Scores, {
      id: "s1",
      project_id: "p",
      trace_id: "t",
      name: "s",
      value: 1,
      timestamp: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
      event_ts: Date.now(),
      is_deleted: 0,
    } as any);
    await vi.advanceTimersByTimeAsync(writer.writeInterval);
    const lastCall = mockInsert.mock.calls[mockInsert.mock.calls.length - 1];
    expect(lastCall[0]).toBe("scores");
    expect((lastCall[3] as any)?.label).toBeUndefined();
  });

  it("gauge counts failed attempts (fail=) and dropped rows (drop=) per window", async () => {
    writer.maxAttempts = 1; // finite: first failure drops immediately
    vi.spyOn(dorisClientMock, "insert").mockRejectedValue(
      new Error("DB Error"),
    );

    writer.addToQueue(TableName.Traces, mkTrace("1"));
    await vi.advanceTimersByTimeAsync(writer.writeInterval); // attempt fails → drop

    expect((writer as any).failCounters.get(TableName.Traces)).toBe(1);
    expect((writer as any).dropCounters.get(TableName.Traces)).toBe(1);

    // The gauge tick renders both and resets the window.
    await vi.advanceTimersByTimeAsync(writer.gaugeInterval);
    const gaugeLine = (logger.info as any).mock.calls
      .map((c: any) => String(c[0]))
      .find((s: string) => s.includes("fail=1"));
    expect(gaugeLine).toBeDefined();
    expect(gaugeLine).toContain("drop=1");
    expect((writer as any).failCounters.get(TableName.Traces)).toBe(0);
    expect((writer as any).dropCounters.get(TableName.Traces)).toBe(0);
  });
});
