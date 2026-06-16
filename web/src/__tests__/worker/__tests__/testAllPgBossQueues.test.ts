import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it } from "vitest";
import { env as sharedEnv } from "@langfuse/shared/src/env";
import {
  createPgBossQueue,
  ensurePgBossSchedule,
  getAllPgBossQueueNames,
  getPgBossQueueConfig,
  PG_BOSS_SCHEDULE_DEFINITIONS,
  QueueJobs,
  QueueName,
  startPgBoss,
  stopPgBoss,
  type PgBossJobEnvelope,
} from "@langfuse/shared/src/server";
import { env as workerEnv } from "@/src/env.mjs";

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SMOKE_JOB = "pgboss-smoke-job" as QueueJobs;
const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;
const SMOKE_TEST_TIMEOUT_MS = 180_000;

type SmokePayload = {
  queueName: QueueName;
  runId: string;
  kind: string;
};

const tempQueueName = (queueName: QueueName, suffix = "queue"): QueueName =>
  `${queueName}__${suffix}__${RUN_ID}` as QueueName;

const sleep = async (ms: number) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  predicate: () => boolean,
  timeoutMs: number = WAIT_TIMEOUT_MS,
) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
};

const runQueueSmoke = async (queueName: QueueName) => {
  const config = getPgBossQueueConfig(queueName);
  const tempName = tempQueueName(queueName);
  const queue = createPgBossQueue(tempName, {
    queueOptions: { ...config.queueOptions },
    defaultSendOptions: config.defaultSendOptions
      ? { ...config.defaultSendOptions }
      : undefined,
    defaultWorkOptions: config.defaultWorkOptions
      ? { ...config.defaultWorkOptions }
      : undefined,
  });

  const consumed: PgBossJobEnvelope<SmokePayload>[] = [];
  let workerId: string | null = null;

  try {
    workerId = await queue.registerWorker(
      {
        localConcurrency: 1,
        pollingIntervalSeconds: 0.5,
        batchSize: 5,
      },
      async (jobs) => {
        for (const job of jobs) {
          consumed.push(job.data as PgBossJobEnvelope<SmokePayload>);
        }
      },
    );

    const immediateId = await queue.send(
      SMOKE_JOB,
      {
        queueName,
        runId: RUN_ID,
        kind: "immediate",
      },
      { startAfter: 0 },
    );

    await waitFor(() => consumed.some((job) => job.id === immediateId));

    const duplicateId = randomUUID();
    const firstDuplicateId = await queue.send(
      SMOKE_JOB,
      {
        queueName,
        runId: RUN_ID,
        kind: "duplicate-id-1",
      },
      {
        id: duplicateId,
        startAfter: 60,
      },
    );
    const secondDuplicateId = await queue.send(
      SMOKE_JOB,
      {
        queueName,
        runId: RUN_ID,
        kind: "duplicate-id-2",
      },
      {
        id: duplicateId,
        startAfter: 60,
      },
    );

    assert.equal(firstDuplicateId, duplicateId);
    assert.equal(secondDuplicateId, duplicateId);
    assert.equal((await queue.findJobs({ id: duplicateId })).length, 1);

    const singletonKey = `${queueName}:${RUN_ID}:singleton`;
    const firstSingletonId = await queue.send(
      SMOKE_JOB,
      {
        queueName,
        runId: RUN_ID,
        kind: "singleton-1",
      },
      {
        singletonKey,
        startAfter: 60,
      },
    );
    const secondSingletonId = await queue.send(
      SMOKE_JOB,
      {
        queueName,
        runId: RUN_ID,
        kind: "singleton-2",
      },
      {
        singletonKey,
        startAfter: 60,
      },
    );

    assert.equal(secondSingletonId, firstSingletonId);
    assert.equal((await queue.findJobs({ key: singletonKey })).length, 1);

    const defaultStartAfter = config.defaultSendOptions?.startAfter;
    if (typeof defaultStartAfter === "number" && defaultStartAfter > 0) {
      const delayedId = await queue.send(SMOKE_JOB, {
        queueName,
        runId: RUN_ID,
        kind: "default-delay",
      });

      await sleep(1_500);
      assert.equal(
        consumed.some((job) => job.id === delayedId),
        false,
        `${queueName} consumed its default delayed job too early`,
      );
      assert.equal(await queue.getJobState(delayedId), "created");

      await queue.deleteJobs([delayedId]);
    }

    await queue.deleteAllJobs();

    return {
      queueName,
      defaultDelaySeconds:
        typeof defaultStartAfter === "number" ? defaultStartAfter : 0,
    };
  } finally {
    if (workerId) {
      await queue.unregisterWorker(workerId);
    }

    const boss = await startPgBoss();
    await boss.deleteAllJobs(tempName).catch(() => undefined);
    await boss.deleteQueue(tempName).catch(() => undefined);
  }
};

const runScheduleSmoke = async (
  definition: (typeof PG_BOSS_SCHEDULE_DEFINITIONS)[number],
) => {
  const tempName = tempQueueName(definition.queueName, "schedule");
  const tempKey = `${definition.key}__${RUN_ID}`;

  try {
    await ensurePgBossSchedule({
      ...definition,
      queueName: tempName,
      key: tempKey,
      queueOptions: { ...definition.queueOptions },
      data: {
        sourceQueueName: definition.queueName,
        runId: RUN_ID,
      },
    });

    const boss = await startPgBoss();
    const schedules = await boss.getSchedules(tempName, tempKey);

    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]?.name, tempName);
    assert.equal(schedules[0]?.key, tempKey);
    assert.equal(schedules[0]?.cron, definition.cron);

    return {
      queueName: definition.queueName,
      cron: definition.cron,
    };
  } finally {
    const boss = await startPgBoss();
    await boss.unschedule(tempName, tempKey).catch(() => undefined);
    await boss.deleteAllJobs(tempName).catch(() => undefined);
    await boss.deleteQueue(tempName).catch(() => undefined);
  }
};

if (process.env.RUN_PGBOSS_SMOKE !== "true") {
  describe.skip("pg-boss queue smoke verification", () => {
    it("runs only when RUN_PGBOSS_SMOKE=true", () => {});
  });
} else {
  describe("pg-boss queue smoke verification", () => {
    beforeAll(async () => {
      sharedEnv.LITEFUSE_PG_BOSS_ENABLED = "true";
      workerEnv.LITEFUSE_PG_BOSS_ENABLED = "true";
      sharedEnv.LITEFUSE_PG_BOSS_POOL_MAX = Math.max(
        sharedEnv.LITEFUSE_PG_BOSS_POOL_MAX,
        20,
      );

      await startPgBoss();
    }, 30_000);

    afterAll(async () => {
      await stopPgBoss().catch(() => undefined);
    }, 30_000);

    it(
      "verifies all pg-boss queues and schedules",
      async () => {
        const queueResults = [];
        for (const queueName of getAllPgBossQueueNames()) {
          queueResults.push(await runQueueSmoke(queueName));
        }

        const scheduleResults = [];
        for (const definition of PG_BOSS_SCHEDULE_DEFINITIONS) {
          scheduleResults.push(await runScheduleSmoke(definition));
        }

        console.log(
          `Verified ${queueResults.length} pg-boss queues and ${scheduleResults.length} schedules`,
        );
        console.table(
          queueResults.map((result) => ({
            queue: result.queueName,
            defaultDelaySeconds: result.defaultDelaySeconds,
          })),
        );
        console.table(
          scheduleResults.map((result) => ({
            queue: result.queueName,
            cron: result.cron,
          })),
        );
      },
      SMOKE_TEST_TIMEOUT_MS,
    );
  });
}
