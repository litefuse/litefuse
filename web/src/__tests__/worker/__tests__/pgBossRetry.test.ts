/**
 * pg-boss retry integration tests via WorkerManager.register.
 *
 * Verifies that queue-level retry options (retryLimit, retryDelay,
 * retryBackoff) passed through WorkerManager.register cause pg-boss
 * to retry failed handler executions.
 *
 * Requires: PostgreSQL running + LITEFUSE_PG_BOSS_ENABLED=true
 *
 * Run: npx dotenv -e ../.env -- npx vitest run --pool=forks
 *      --poolOptions.forks.singleFork=true src/__tests__/pgBossRetry.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getPgBossQueue,
  QueueJobs,
  QueueName,
  startPgBoss,
  stopPgBoss,
} from "@langfuse/shared/src/server";
import { WorkerManager } from "@/src/server/background/queues/workerManager";
import { env } from "@/src/env.mjs";

type RetryPayload = { id: string };

const TEST_JOB = "test-retry-job" as QueueJobs;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Setup / Teardown ────────────────────────────────────────────────

beforeAll(async () => {
  env.LITEFUSE_PG_BOSS_ENABLED = "true";
}, 15_000);

afterAll(async () => {
  const boss = await startPgBoss();
  for (const q of [Q1, Q2, Q3]) {
    try {
      await boss.deleteQueue(q);
    } catch {
      /* ignore */
    }
    try {
      await boss.deleteAllJobs(q);
    } catch {
      /* ignore */
    }
  }
  await stopPgBoss();
  env.LITEFUSE_PG_BOSS_ENABLED = "false";
  WorkerManager.__testReset();
}, 15_000);

// Each test gets its own queue to avoid cross-test state leakage.
const Q1 = "test-pgboss-retry-1" as QueueName;
const Q2 = "test-pgboss-retry-2" as QueueName;
const Q3 = "test-pgboss-retry-3" as QueueName;

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("WorkerManager.register retry", () => {
  it("retries a failing handler up to retryLimit, then succeeds", async () => {
    let attempts = 0;
    let succeeded = false;

    WorkerManager.register(
      Q1,
      async (_job: { data: { payload: RetryPayload } }) => {
        attempts++;
        if (attempts < 3) {
          throw new Error(`Simulated failure, attempt ${attempts}`);
        }
        succeeded = true;
      },
      {
        queueOptions: {
          retryLimit: 3,
          retryDelay: 1,
          retryBackoff: false,
          deleteAfterSeconds: 120,
        },
        pollingIntervalSeconds: 0.5,
      },
    );

    await wait(1000);

    const queue = getPgBossQueue(Q1);
    await queue.send(TEST_JOB, {
      id: `retry-ok-${Date.now()}`,
    } as RetryPayload);

    const deadline = Date.now() + 20_000;
    while (!succeeded && Date.now() < deadline) {
      await wait(200);
    }

    // Cleanup this queue so the retried (completed) jobs don't
    // interfere with later runs.
    const boss = await startPgBoss();
    await boss.deleteQueue(Q1);

    expect(succeeded).toBe(true);
    expect(attempts).toBe(3); // 2 failures + 1 success
  }, 25_000);

  it("handler is called at least retryLimit times when always failing", async () => {
    let attempts = 0;

    WorkerManager.register(
      Q2,
      async (_job: { data: { payload: RetryPayload } }) => {
        attempts++;
        throw new Error("Always fail");
      },
      {
        queueOptions: {
          retryLimit: 2,
          retryDelay: 1,
          retryBackoff: false,
          deleteAfterSeconds: 120,
        },
        pollingIntervalSeconds: 0.5,
      },
    );

    await wait(1000);

    const queue = getPgBossQueue(Q2);
    await queue.send(TEST_JOB, {
      id: `always-fail-${Date.now()}`,
    } as RetryPayload);

    // Wait until attempts stabilise (no new calls for a few seconds)
    let last = 0;
    let stable = 0;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && stable < 5) {
      await wait(500);
      if (attempts === last) {
        stable++;
      } else {
        last = attempts;
        stable = 0;
      }
    }

    const boss = await startPgBoss();
    await boss.deleteQueue(Q2);

    // At least the original + retries; the exact total depends on
    // pg-boss internals and timing. retryLimit=2 plus the original
    // attempt gives at least 2 calls.
    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("succeeds on first attempt when handler does not throw", async () => {
    const received: string[] = [];

    WorkerManager.register(
      Q3,
      async (job: { data: { payload: RetryPayload } }) => {
        received.push(job.data.payload.id);
      },
      {
        queueOptions: {
          retryLimit: 3,
          retryDelay: 1,
          retryBackoff: false,
          deleteAfterSeconds: 120,
        },
        pollingIntervalSeconds: 0.5,
      },
    );

    await wait(1000);

    const queue = getPgBossQueue(Q3);
    const jobId = `no-retry-${Date.now()}`;
    await queue.send(TEST_JOB, { id: jobId } as RetryPayload);

    const deadline = Date.now() + 10_000;
    while (!received.includes(jobId) && Date.now() < deadline) {
      await wait(200);
    }

    const boss = await startPgBoss();
    await boss.deleteQueue(Q3);

    expect(received).toContain(jobId);
    expect(received.filter((id) => id === jobId).length).toBe(1);
  }, 15_000);
});
