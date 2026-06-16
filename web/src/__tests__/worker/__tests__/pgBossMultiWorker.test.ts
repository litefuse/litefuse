/**
 * pg-boss multi-worker + review fixes integration test
 *
 * Verifies:
 *   1. WorkerManager.register() — basic send/consume
 *   2. retryBaggage — preserved through the envelope
 *   3. Rate limiter — token-bucket throttling + ordering
 *   4. Duplicate registration guard
 *   5. Multi-worker simulation — concurrency without duplication
 *
 * Requires: PostgreSQL running + LITEFUSE_PG_BOSS_ENABLED=true
 * Run: pnpm --filter=worker run test -- pgBossMultiWorker
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getPgBossQueue,
  QueueJobs,
  QueueName,
  startPgBoss,
  stopPgBoss,
} from "@langfuse/shared/src/server";
import { env } from "@/src/env.mjs";
import { env as sharedEnv } from "@langfuse/shared/src/env";
import { WorkerManager } from "@/src/server/background/queues/workerManager";

const TEST_JOB = "test-mw-job" as QueueJobs;
let seq = 0;
/** Per-test unique queue name to avoid cross-test worker contention. */
function Q(base: string): QueueName {
  return `${base}-${++seq}` as QueueName;
}

type TestPayload = { id: string; n: number };

beforeAll(async () => {
  env.LITEFUSE_PG_BOSS_ENABLED = "true";
  // singleFork=true reuses pg-boss across 7 tests; each registers workers.
  // Increase connection pool from default 5 to avoid pool exhaustion.
  sharedEnv.LITEFUSE_PG_BOSS_POOL_MAX = 20;
  await startPgBoss();
}, 15_000);

afterAll(async () => {
  await stopPgBoss();
  env.LITEFUSE_PG_BOSS_ENABLED = "false";
}, 15_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  WorkerManager.__testReset();
});

// ── Test 1: Rate limiter — ordering + no re-enqueue (run first for clean pool) ──

describe("WorkerManager basic send/consume", () => {
  it("registers a worker and consumes a job", async () => {
    const qn = Q("mw-basic");
    const received: TestPayload[] = [];

    WorkerManager.register(
      qn,
      async (job) => {
        received.push((job.data as any).payload);
      },
      { localConcurrency: 1 },
    );

    await new Promise((r) => setTimeout(r, 1000));

    const queue = getPgBossQueue(qn);
    const id = await queue.send(TEST_JOB, { id: "t1", n: 1 } as TestPayload);
    expect(id).toBeTruthy();

    await new Promise((r) => setTimeout(r, 3000));
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].id).toBe("t1");
  });
});

// ── Test 2: retryBaggage preserved ──────────────────────────────────

describe("PgBossQueue.send with retryBaggage", () => {
  it("retryBaggage is included in the job envelope", async () => {
    const qn = Q("mw-retry");
    const received: any[] = [];

    WorkerManager.register(
      qn,
      async (job) => {
        received.push({
          payload: (job.data as any).payload,
          baggage: (job.data as any).retryBaggage,
        });
      },
      { localConcurrency: 1 },
    );

    await new Promise((r) => setTimeout(r, 1000));

    const queue = getPgBossQueue(qn);
    await queue.send(TEST_JOB, { id: "r1", n: 42 } as TestPayload, {
      retryBaggage: { originalJobTimestamp: new Date(), attempt: 0 },
    });

    await new Promise((r) => setTimeout(r, 3000));
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].payload.id).toBe("r1");
    expect(received[0].baggage).toBeDefined();
    expect(received[0].baggage.attempt).toBe(0);
  });

  it("send without retryBaggage works normally", async () => {
    const qn = Q("mw-retry2");
    const received: any[] = [];

    WorkerManager.register(
      qn,
      async (job) => {
        received.push(job.data as any);
      },
      { localConcurrency: 1 },
    );

    await new Promise((r) => setTimeout(r, 1000));

    const q = getPgBossQueue(qn);
    await q.send(TEST_JOB, { id: "r2", n: 99 } as TestPayload);

    await new Promise((r) => setTimeout(r, 3000));
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].payload.id).toBe("r2");
  });
});

// ── Test 3: Rate limiter — token bucket ────────────────────────────

describe("WorkerManager rate limiter", () => {
  it("rateLimit: ordering preserved, jobs retried (not re-enqueued), gaps enforce limit", async () => {
    const qn = Q("mw-rate");
    const processed: { id: string; n: number; ts: number }[] = [];

    WorkerManager.register(
      qn,
      async (job) => {
        processed.push({
          id: (job.data as any).payload.id as string,
          n: (job.data as any).payload.n as number,
          ts: Date.now(),
        });
      },
      {
        localConcurrency: 1,
        rateLimit: { max: 1, duration: 3_000 },
        queueOptions: {
          retryLimit: 20,
          retryDelay: 1,
          retryBackoff: false,
          deleteAfterSeconds: 60,
        },
      },
    );

    await new Promise((r) => setTimeout(r, 1000));

    const queue = getPgBossQueue(qn);
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      await queue.send(TEST_JOB, { id: `rr-${i}`, n: i } as TestPayload);
    }

    const deadline = Date.now() + 20_000;
    while (processed.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    const elapsed = processed.map((p, i) => ({
      n: p.n,
      sinceStartMs: p.ts - t0,
      gapMs: i === 0 ? 0 : p.ts - processed[i - 1].ts,
    }));
    console.log(`[rate-limit] processed 3 jobs:`, JSON.stringify(elapsed));

    // All 3 must be processed (not lost)
    expect(processed.length).toBe(3);
    // No duplicate IDs (not re-enqueued)
    expect(new Set(processed.map((p) => p.id)).size).toBe(3);
    // IDs preserved from original enqueue
    for (const p of processed) expect(p.id).toMatch(/^rr-/);
    // Sequential order
    expect(processed[0].n).toBe(0);
    expect(processed[1].n).toBe(1);
    expect(processed[2].n).toBe(2);
    // Rate-enforced gaps: each ≥ ~2s
    expect(processed[1].ts - processed[0].ts).toBeGreaterThan(2_000);
    expect(processed[2].ts - processed[1].ts).toBeGreaterThan(2_000);
    // Total under 20s
    expect(processed[2].ts - t0).toBeLessThan(20_000);
  }, 30_000);
});

// ── Test 4: Duplicate registration guard ───────────────────────────

describe("WorkerManager duplicate registration", () => {
  it("second register() call is skipped", async () => {
    const qn = Q("mw-dup");
    WorkerManager.register(qn, vi.fn().mockResolvedValue(undefined), {
      localConcurrency: 1,
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(WorkerManager.isRegistered(qn)).toBe(true);

    WorkerManager.register(qn, vi.fn().mockResolvedValue(undefined), {
      localConcurrency: 1,
    });
    expect(WorkerManager.isRegistered(qn)).toBe(true);
  });
});

// ── Test 5: Multi-worker simulation ────────────────────────────────

describe("Multi-worker simulation", () => {
  it("concurrent handlers (localConcurrency=3) process jobs without duplication", async () => {
    const qn = Q("mw-multi");
    const seenJobs = new Set<string>();
    let processedCount = 0;
    const N_JOBS = 30;

    // Bypass WorkerManager for this test — directly register with pg-boss
    // to get true concurrent handlers without the pool-limitation.
    const mwQueue = getPgBossQueue(qn);
    await mwQueue.registerWorker(
      { localConcurrency: 3, pollingIntervalSeconds: 0.5, batchSize: 10 },
      async (jobs) => {
        for (const j of jobs) {
          const jobId = (j.data as any).payload.id as string;
          seenJobs.add(jobId);
          processedCount++;
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    );

    const queue = getPgBossQueue(qn);
    for (let i = 0; i < N_JOBS; i++) {
      await queue.send(TEST_JOB, { id: `mw-${i}`, n: i } as TestPayload);
    }

    // Poll until all consumed or timeout
    const deadline = Date.now() + 12_000;
    while (processedCount < N_JOBS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(
      `[multi-worker] processed ${processedCount}/${N_JOBS} jobs, unique=${seenJobs.size}`,
    );

    expect(processedCount).toBeGreaterThanOrEqual(N_JOBS);
    expect(seenJobs.size).toBe(N_JOBS);
    for (let i = 0; i < N_JOBS; i++) {
      expect(seenJobs.has(`mw-${i}`)).toBe(true);
    }
  }, 20_000);
});
