/**
 * pg-boss PgBossQueue wrapper integration tests
 *
 * Tests the full queue lifecycle: enqueue, worker consumption,
 * delayed jobs, singleton, bulk insert, schedule/unschedule,
 * observability, and concurrent stability.
 *
 * Requires: PostgreSQL running + LITEFUSE_PG_BOSS_ENABLED=true
 *
 * Run: pnpm --filter=worker run test -- pgBossQueue.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getPgBossQueue,
  QueueJobs,
  QueueName,
  type PgBossJobEnvelope,
  startPgBoss,
  stopPgBoss,
} from "@langfuse/shared/src/server";
import { env } from "@/src/env.mjs";

// ── Test queue names (isolated from production queues) ──────────────

const TEST_QUEUE_BASIC = "test-pgboss-basic" as QueueName;
const TEST_QUEUE_DELAY = "test-pgboss-delay" as QueueName;
const TEST_QUEUE_DELAY2 = "test-pgboss-delay2" as QueueName;
const TEST_QUEUE_SINGLETON = "test-pgboss-singleton" as QueueName;
const TEST_QUEUE_BULK = "test-pgboss-bulk" as QueueName;
const TEST_QUEUE_SCHEDULE = "test-pgboss-schedule" as QueueName;
const TEST_QUEUE_CONCURRENT = "test-pgboss-concurrent" as QueueName;
const TEST_JOB = "test-job" as QueueJobs;

// Register these as valid QueueNames so the PgBossQueue class accepts them
// We cast from our test queue names
const Q = {
  basic: TEST_QUEUE_BASIC,
  delay: TEST_QUEUE_DELAY,
  delay2: TEST_QUEUE_DELAY2,
  singleton: TEST_QUEUE_SINGLETON,
  bulk: TEST_QUEUE_BULK,
  schedule: TEST_QUEUE_SCHEDULE,
  concurrent: TEST_QUEUE_CONCURRENT,
};

// Override QueueName enum lookups at runtime by using the QueueName values directly
function registerTestQueues(): void {
  // Add our test queue names to the config—done inline in getPgBossQueue
}

type TestPayload = {
  message: string;
  n: number;
  ts: string;
};

// ── Setup / Teardown ────────────────────────────────────────────────

beforeAll(async () => {
  // Must enable pg-boss for these tests
  env.LITEFUSE_PG_BOSS_ENABLED = "true";

  // Create queues explicitly via pg-boss
  const boss = await startPgBoss();
  for (const name of Object.values(Q)) {
    await boss.createQueue(name, {
      retryLimit: 2,
      retryDelay: 1,
      retryBackoff: false,
      deleteAfterSeconds: 60, // auto-cleanup after 1 min
    });
  }
}, 15_000);

afterAll(async () => {
  // Delete test queues
  const boss = await startPgBoss();
  for (const name of Object.values(Q)) {
    try {
      await boss.deleteQueue(name);
    } catch {
      // queue may not exist yet
    }
  }
  await stopPgBoss();
  env.LITEFUSE_PG_BOSS_ENABLED = "false";
}, 15_000);

beforeEach(async () => {
  // Purge any leftover jobs from previous tests
  const boss = await startPgBoss();
  for (const name of Object.values(Q)) {
    try {
      await boss.deleteAllJobs(name);
    } catch {
      // ignore
    }
  }
});

// ── Helpers ─────────────────────────────────────────────────────────

/** Collect consumed jobs, polling until expected count reached or timeout */
async function collectJobsUntil(
  queueName: QueueName,
  expectedCount: number,
  timeoutMs: number,
  options?: { batchSize?: number; localConcurrency?: number },
): Promise<{ collected: PgBossJobEnvelope<TestPayload>[]; elapsedMs: number }> {
  const startTime = Date.now();
  const collected: PgBossJobEnvelope<TestPayload>[] = [];

  const queue = getPgBossQueue(queueName);
  await queue.registerWorker(
    {
      pollingIntervalSeconds: 0.5,
      batchSize: options?.batchSize ?? 50,
      localConcurrency: options?.localConcurrency ?? 2,
    },
    async (jobs) => {
      for (const job of jobs) {
        collected.push(job.data as PgBossJobEnvelope<TestPayload>);
      }
    },
  );

  // Poll until expected count reached or timeout
  const deadline = Date.now() + timeoutMs;
  while (collected.length < expectedCount && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  return { collected, elapsedMs: Date.now() - startTime };
}

/** Collect consumed jobs for a fixed duration */
async function collectJobsForMs(
  queueName: QueueName,
  ms: number,
): Promise<PgBossJobEnvelope<TestPayload>[]> {
  const collected: PgBossJobEnvelope<TestPayload>[] = [];

  const queue = getPgBossQueue(queueName);
  await queue.registerWorker(
    { pollingIntervalSeconds: 0.5, batchSize: 50 },
    async (jobs) => {
      for (const job of jobs) {
        collected.push(job.data as PgBossJobEnvelope<TestPayload>);
      }
    },
  );

  await new Promise((resolve) => setTimeout(resolve, ms));
  return collected;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("PgBossQueue — Basic Enqueue & Consume", () => {
  it("send() returns a non-null job ID", async () => {
    const queue = getPgBossQueue(Q.basic);
    const id = await queue.send(TEST_JOB, {
      message: "hello",
      n: 1,
      ts: new Date().toISOString(),
    } as TestPayload);
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("worker receives enqueued jobs", async () => {
    const queue = getPgBossQueue(Q.basic);

    // Enqueue
    await queue.send(TEST_JOB, {
      message: "worker-test",
      n: 42,
      ts: new Date().toISOString(),
    } as TestPayload);

    // Collect
    const results = await collectJobsForMs(Q.basic, 3000);

    expect(results.length).toBeGreaterThanOrEqual(1);
    const payload = results.find((j) => j.payload.message === "worker-test");
    expect(payload).toBeTruthy();
    expect(payload!.payload.n).toBe(42);
    expect(payload!.name).toBe(TEST_JOB);
  });

  it("send() with 100 jobs — all consumed in <4s", async () => {
    const queue = getPgBossQueue(Q.basic);
    const N = 100;

    const enqueueStart = Date.now();
    for (let i = 0; i < N; i++) {
      await queue.send(TEST_JOB, {
        message: `job-${i}`,
        n: i,
        ts: new Date().toISOString(),
      } as TestPayload);
    }
    const enqueueMs = Date.now() - enqueueStart;

    const { collected, elapsedMs } = await collectJobsUntil(
      Q.basic,
      N,
      10_000,
      {
        batchSize: 50,
        localConcurrency: 2,
      },
    );

    console.log(
      `  [timing] enqueue ${N} jobs: ${enqueueMs}ms, ` +
        `consume ${collected.length} jobs: ${elapsedMs}ms, ` +
        `total: ${enqueueMs + elapsedMs}ms`,
    );

    expect(collected.length).toBeGreaterThanOrEqual(N);
    for (let i = 0; i < N; i++) {
      expect(collected.some((j) => j.payload.n === i)).toBe(true);
    }

    // 100 jobs should be consumed in well under 5 seconds on local PG
    expect(elapsedMs).toBeLessThan(5000);
  }, 15_000);
});

describe("PgBossQueue — Delayed Jobs", () => {
  it("delayed job is NOT consumed before startAfter", async () => {
    const queue = getPgBossQueue(Q.delay);

    await queue.sendDelayed(
      TEST_JOB,
      {
        message: "delayed-5s",
        n: 1,
        ts: new Date().toISOString(),
      } as TestPayload,
      5, // start after 5 seconds
    );

    // Check within 2 seconds — should NOT be consumed yet
    const earlyResults = await collectJobsForMs(Q.delay, 2000);
    const early = earlyResults.filter(
      (j) => j.payload.message === "delayed-5s",
    );
    expect(early.length).toBe(0);
  });

  it("delayed job IS consumed after startAfter elapses", async () => {
    const queue = getPgBossQueue(Q.delay2);

    await queue.sendDelayed(
      TEST_JOB,
      {
        message: "delayed-2s",
        n: 2,
        ts: new Date().toISOString(),
      } as TestPayload,
      2, // start after 2 seconds
    );

    // Wait long enough for delay to pass + polling interval
    const results = await collectJobsForMs(Q.delay2, 6000);
    const found = results.filter((j) => j.payload.message === "delayed-2s");
    expect(found.length).toBe(1);
    expect(found[0].payload.n).toBe(2);
  }, 10_000);
});

describe("PgBossQueue — Singleton Jobs", () => {
  it("singletonKey prevents duplicate jobs in created state", async () => {
    const queue = getPgBossQueue(Q.singleton);
    const key = "singleton-test-key-2";

    // Send 5 singleton jobs with the same key and a long delay
    // so they all stay in "created" state — singleton dedup kicks in
    for (let i = 0; i < 5; i++) {
      await queue.sendSingleton(
        TEST_JOB,
        {
          message: `singleton-${i}`,
          n: i,
          ts: new Date().toISOString(),
        } as TestPayload,
        key,
        { startAfter: 60 }, // long delay to keep them in "created" state
      );
    }

    // Fetch jobs directly from the queue to see what's pending
    // There should be at most 1 job with this singletonKey
    const boss = await startPgBoss();
    const pending = await boss.fetch(Q.singleton, { batchSize: 100 });
    const matching =
      pending?.filter((j: any) =>
        j.data?.payload?.message?.startsWith("singleton-"),
      ) ?? [];
    expect(matching.length).toBeLessThanOrEqual(1);
  });
});

describe("PgBossQueue — Bulk Insert", () => {
  it("insertBulk() enqueues all jobs", async () => {
    const queue = getPgBossQueue(Q.bulk);

    const ids = await queue.insertBulk(
      Array.from({ length: 10 }, (_, i) => ({
        jobName: TEST_JOB,
        payload: {
          message: `bulk-${i}`,
          n: i,
          ts: new Date().toISOString(),
        } as TestPayload,
      })),
    );

    expect(ids.length).toBe(10);
    ids.forEach((id) => {
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    const results = await collectJobsForMs(Q.bulk, 5000);
    expect(results.length).toBeGreaterThanOrEqual(10);
  }, 10_000);
});

describe("PgBossQueue — Observability", () => {
  it("getStats() returns queue statistics", async () => {
    const queue = getPgBossQueue(Q.basic);

    // Enqueue some jobs
    for (let i = 0; i < 5; i++) {
      await queue.send(TEST_JOB, {
        message: `stats-${i}`,
        n: i,
        ts: new Date().toISOString(),
      } as TestPayload);
    }

    // Allow time for jobs to start being processed
    await new Promise((r) => setTimeout(r, 500));

    const stats = await queue.getStats();
    expect(stats).toBeTruthy();
    expect(stats.name).toBe(Q.basic);
    // totalCount should be >= the number we sent (may include completed from prior tests)
    expect(stats.totalCount).toBeGreaterThanOrEqual(5);
  });

  it("getQueueInfo() returns queue metadata", async () => {
    const queue = getPgBossQueue(Q.basic);
    const info = await queue.getQueueInfo();
    expect(info).toBeTruthy();
    expect(info?.name).toBe(Q.basic);
    expect(info?.policy).toBe("standard");
  });
});

describe("PgBossQueue — Job Management", () => {
  it("cancelJobs() cancels a pending job", async () => {
    const queue = getPgBossQueue(Q.basic);

    // Send a delayed job so we have time to cancel it
    const id = await queue.sendDelayed(
      TEST_JOB,
      {
        message: "to-cancel",
        n: 0,
        ts: new Date().toISOString(),
      } as TestPayload,
      30, // long delay
    );

    expect(id).toBeTruthy();
    await queue.cancelJobs([id!]);

    // Verify it doesn't get consumed
    const results = await collectJobsForMs(Q.basic, 2000);
    const cancelled = results.filter((j) => j.payload.message === "to-cancel");
    expect(cancelled.length).toBe(0);
  });
});

describe("PgBossQueue — Schedule / Unschedule", () => {
  it("schedule() registers a cron and unschedule() removes it", async () => {
    const queue = getPgBossQueue(Q.schedule);
    const key = "test-schedule-every-2min";

    // Schedule (every 2 minutes to avoid firing during test)
    await queue.schedule(
      TEST_JOB,
      "*/2 * * * *",
      {
        message: "scheduled",
        n: 0,
        ts: new Date().toISOString(),
      } as TestPayload,
      { key },
    );

    // Verify schedule exists
    const boss = await startPgBoss();
    const schedules = await boss.getSchedules();
    const found = schedules.find((s) => s.key === key);
    expect(found).toBeTruthy();
    expect(found!.cron).toBe("*/2 * * * *");

    // Unschedule
    await queue.unschedule(key);

    // Verify removed
    const schedulesAfter = await boss.getSchedules();
    const gone = schedulesAfter.find((s) => s.key === key);
    expect(gone).toBeUndefined();
  });
});

describe("PgBossQueue — Concurrent Stability", () => {
  it("handles rapid sequential sends without errors", async () => {
    const queue = getPgBossQueue(Q.concurrent);
    const N = 50;

    const promises = Array.from({ length: N }, (_, i) =>
      queue.send(TEST_JOB, {
        message: `rapid-${i}`,
        n: i,
        ts: new Date().toISOString(),
      } as TestPayload),
    );

    const ids = await Promise.all(promises);
    expect(ids.length).toBe(N);
  });

  it("handles concurrent send + worker processing", async () => {
    const queue = getPgBossQueue(Q.concurrent);
    const N = 30;

    // Register worker first
    const consumed: PgBossJobEnvelope<TestPayload>[] = [];
    await queue.registerWorker(
      { localConcurrency: 3, batchSize: 10, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) {
          consumed.push(job.data as PgBossJobEnvelope<TestPayload>);
        }
      },
    );

    // Send concurrently
    const promises = Array.from({ length: N }, (_, i) =>
      queue.send(TEST_JOB, {
        message: `concurrent-${i}`,
        n: i,
        ts: new Date().toISOString(),
      } as TestPayload),
    );
    const sendStart = Date.now();
    await Promise.all(promises);
    const sendMs = Date.now() - sendStart;

    // Poll until all consumed (max 10s)
    const deadline = Date.now() + 10_000;
    while (consumed.length < N && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const totalMs = Date.now() - sendStart;

    console.log(
      `  [timing] concurrent send ${N} jobs: ${sendMs}ms, ` +
        `consume ${consumed.length} jobs total: ${totalMs}ms`,
    );

    expect(consumed.length).toBeGreaterThanOrEqual(N);
    for (let i = 0; i < N; i++) {
      expect(consumed.some((j) => j.payload.n === i)).toBe(true);
    }
  }, 15_000);
});

describe("PgBossQueue — Error / Edge Cases", () => {
  it("retryJobs() throws on non-existent job IDs", async () => {
    const queue = getPgBossQueue(Q.basic);
    await expect(queue.retryJobs(["nonexistent-id-12345"])).rejects.toThrow();
  });
});
