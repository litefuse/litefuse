/**
 * Blob Storage Integration — pg-boss scheduling & processing tests
 *
 * Tests the full call chain from cron trigger through per-project processing,
 * without touching real Doris or S3.
 *
 * Run: pnpm --filter=worker run test -- blobStorageIntegrationPgBoss
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
import { randomUUID } from "crypto";

// ── Mocks (hoisted so vi.mock can reference them) ──────────────────

const mocks = vi.hoisted(() => ({
  queryDoris: vi.fn(),
  getTracesForBlobStorageExport: vi.fn(),
  getObservationsForBlobStorageExport: vi.fn(),
  getScoresForBlobStorageExport: vi.fn(),
  getEventsForBlobStorageExport: vi.fn(),
  storageUploadFileBuffered: vi.fn(),
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@langfuse/shared/src/server")>();
  return {
    ...actual,
    queryDoris: mocks.queryDoris,
    getTracesForBlobStorageExport: mocks.getTracesForBlobStorageExport,
    getObservationsForBlobStorageExport:
      mocks.getObservationsForBlobStorageExport,
    getScoresForBlobStorageExport: mocks.getScoresForBlobStorageExport,
    getEventsForBlobStorageExport: mocks.getEventsForBlobStorageExport,
    StorageServiceFactory: {
      getInstance: vi.fn(() => ({
        uploadFileBuffered: mocks.storageUploadFileBuffered,
      })),
    },
  };
});

vi.mock("@langfuse/shared/encryption", () => ({
  decrypt: vi.fn((val: string) => val),
  encrypt: vi.fn((val: string) => val),
}));

// ── Real imports (after mocks) ─────────────────────────────────────

import { prisma } from "@langfuse/shared/src/db";
import {
  getPgBossQueue,
  QueueJobs,
  QueueName,
  startPgBoss,
  stopPgBoss,
  type PgBossJobEnvelope,
} from "@langfuse/shared/src/server";
import { env } from "@/src/env.mjs";
import { handleBlobStorageIntegrationSchedule } from "@/src/server/background/features/blobstorage/handleBlobStorageIntegrationSchedule";
import { handleBlobStorageIntegrationProjectJob } from "@/src/server/background/features/blobstorage/handleBlobStorageIntegrationProjectJob";
import { registerBlobStoragePgBossWorkers } from "@/src/server/background/queues/blobStorageIntegrationQueue";

// ── Helpers ────────────────────────────────────────────────────────

type ProcessingPayload = { projectId: string };
type TestProject = { orgId: string; projectId: string };

let testProjects: TestProject[] = [];

async function createTestProject(): Promise<TestProject> {
  const org = await prisma.organization.create({
    data: {
      name: `bs-test-org-${randomUUID().slice(0, 6)}`,
      cloudConfig: { plan: "Team" } as any,
    },
  });
  const proj = await prisma.project.create({
    data: { name: `bs-test-proj-${randomUUID().slice(0, 6)}`, orgId: org.id },
  });
  const tp = { orgId: org.id, projectId: proj.id };
  testProjects.push(tp);
  return tp;
}

async function createIntegration(params: {
  projectId: string;
  enabled?: boolean;
  lastSyncAt?: Date;
  nextSyncAt?: Date;
  exportFrequency?: string;
  exportMode?: string;
  exportSource?: string;
}) {
  return prisma.blobStorageIntegration.create({
    data: {
      projectId: params.projectId,
      type: "S3",
      bucketName: "test-bucket",
      region: "us-east-1",
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      prefix: "test/",
      exportFrequency: params.exportFrequency ?? "hourly",
      enabled: params.enabled ?? true,
      forcePathStyle: false,
      fileType: "JSONL",
      exportMode: params.exportMode ?? "FROM_TODAY",
      exportSource: params.exportSource ?? "TRACES_OBSERVATIONS",
      lastSyncAt: params.lastSyncAt ?? null,
      nextSyncAt: params.nextSyncAt ?? null,
    },
  });
}

/**
 * Register a worker that captures processing jobs, then purge any backlog
 * so we start from a clean state. Returns the collected array for later assertions.
 */
async function startCollectingJobs(): Promise<
  PgBossJobEnvelope<ProcessingPayload>[]
> {
  const collected: PgBossJobEnvelope<ProcessingPayload>[] = [];
  const queue = getPgBossQueue(QueueName.BlobStorageIntegrationProcessingQueue);

  // Purge backlog first
  try {
    await queue.cancelJobs(["*"]);
  } catch {}
  try {
    const boss = await startPgBoss();
    await boss.deleteAllJobs(QueueName.BlobStorageIntegrationProcessingQueue);
  } catch {}

  await queue.registerWorker(
    { pollingIntervalSeconds: 0.5, batchSize: 20 },
    async (jobs) => {
      for (const j of jobs) {
        collected.push(j.data as PgBossJobEnvelope<ProcessingPayload>);
      }
    },
  );
  return collected;
}

// ── Setup / Teardown ───────────────────────────────────────────────

beforeAll(async () => {
  env.LITEFUSE_PG_BOSS_ENABLED = "true";
  await startPgBoss();

  // Clean up stale test data from previous runs
  try {
    const staleOrgs = await prisma.organization.findMany({
      where: { name: { startsWith: "bs-test-org-" } },
      select: { id: true },
    });
    for (const org of staleOrgs) {
      const projects = await prisma.project.findMany({
        where: { orgId: org.id },
        select: { id: true },
      });
      const projectIds = projects.map((p) => p.id);
      if (projectIds.length > 0) {
        await prisma.blobStorageIntegration.deleteMany({
          where: { projectId: { in: projectIds } },
        });
      }
      await prisma.project.deleteMany({ where: { orgId: org.id } });
      await prisma.organization.deleteMany({ where: { id: org.id } });
    }
  } catch {}

  // Default mocks: empty data, no uploads
  mocks.queryDoris.mockResolvedValue([{ min_timestamp: null }]);
  mocks.getTracesForBlobStorageExport.mockImplementation(async function* () {});
  mocks.getObservationsForBlobStorageExport.mockImplementation(
    async function* () {},
  );
  mocks.getScoresForBlobStorageExport.mockImplementation(async function* () {});
  mocks.getEventsForBlobStorageExport.mockImplementation(async function* () {});
  mocks.storageUploadFileBuffered.mockResolvedValue(undefined);
}, 15_000);

afterAll(async () => {
  for (const tp of testProjects) {
    try {
      await prisma.blobStorageIntegration.deleteMany({
        where: { projectId: tp.projectId },
      });
      await prisma.project.deleteMany({ where: { id: tp.projectId } });
      await prisma.organization.deleteMany({ where: { id: tp.orgId } });
    } catch {}
  }
  await stopPgBoss();
  env.LITEFUSE_PG_BOSS_ENABLED = "false";
}, 15_000);

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.queryDoris.mockResolvedValue([{ min_timestamp: null }]);
  mocks.getTracesForBlobStorageExport.mockImplementation(async function* () {});
  mocks.getObservationsForBlobStorageExport.mockImplementation(
    async function* () {},
  );
  mocks.getScoresForBlobStorageExport.mockImplementation(async function* () {});
  mocks.getEventsForBlobStorageExport.mockImplementation(async function* () {});
  mocks.storageUploadFileBuffered.mockResolvedValue(undefined);

  // Clean up test data from previous tests to prevent leakage
  const projectIds = testProjects.map((tp) => tp.projectId);
  if (projectIds.length > 0) {
    await prisma.blobStorageIntegration.deleteMany({
      where: { projectId: { in: projectIds } },
    });
  }
  // Purge processing queue backlog
  try {
    const boss = await startPgBoss();
    await boss.deleteAllJobs(QueueName.BlobStorageIntegrationProcessingQueue);
  } catch {}
});

// ═══════════════════════════════════════════════════════════════════════
// Schedule tests
// ═══════════════════════════════════════════════════════════════════════

describe("Blob Storage Integration — Schedule", () => {
  it("enqueues nothing when no integrations exist", async () => {
    const boss = await startPgBoss();
    await boss.deleteAllJobs(QueueName.BlobStorageIntegrationProcessingQueue);

    await handleBlobStorageIntegrationSchedule();
    await new Promise((r) => setTimeout(r, 500));

    const stats = await getPgBossQueue(
      QueueName.BlobStorageIntegrationProcessingQueue,
    ).getStats();
    expect(stats.totalCount).toBe(0);
  });

  it("enqueues nothing when integration is already synced and not yet due", async () => {
    const tp = await createTestProject();
    const past = new Date(Date.now() - 3600000); // synced an hour ago
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000); // next sync tomorrow
    await createIntegration({
      projectId: tp.projectId,
      lastSyncAt: past,
      nextSyncAt: future,
    });

    const boss = await startPgBoss();
    await boss.deleteAllJobs(QueueName.BlobStorageIntegrationProcessingQueue);

    await handleBlobStorageIntegrationSchedule();
    await new Promise((r) => setTimeout(r, 500));

    // No new jobs because lastSyncAt IS NOT null AND nextSyncAt is in the future
    const stats = await getPgBossQueue(
      QueueName.BlobStorageIntegrationProcessingQueue,
    ).getStats();
    expect(stats.totalCount).toBe(0);
  });

  it("insertBulk is called with due project's payload", async () => {
    const tp = await createTestProject();
    const past = new Date(Date.now() - 3600000);
    await createIntegration({ projectId: tp.projectId, nextSyncAt: past });

    // Spy on insertBulk to verify what gets enqueued
    const queue = getPgBossQueue(
      QueueName.BlobStorageIntegrationProcessingQueue,
    );
    const spy = vi.spyOn(queue, "insertBulk");

    await handleBlobStorageIntegrationSchedule();

    expect(spy).toHaveBeenCalledTimes(1);
    const calls = spy.mock.calls[0][0];
    expect(calls.length).toBe(1);
    expect(calls[0].payload.projectId).toBe(tp.projectId);
    expect(calls[0].jobName).toBe(
      QueueJobs.BlobStorageIntegrationProcessingJob,
    );
    expect(calls[0].options?.singletonKey).toContain(tp.projectId);
  });

  it("skips disabled integrations even if due", async () => {
    const tp = await createTestProject();
    const past = new Date(Date.now() - 3600000);
    await createIntegration({
      projectId: tp.projectId,
      enabled: false,
      nextSyncAt: past,
    });

    const queue = getPgBossQueue(
      QueueName.BlobStorageIntegrationProcessingQueue,
    );
    const spy = vi.spyOn(queue, "insertBulk");

    await handleBlobStorageIntegrationSchedule();

    expect(spy).not.toHaveBeenCalled();
  });

  it("enqueues multiple due projects", async () => {
    const tp1 = await createTestProject();
    const tp2 = await createTestProject();
    const past = new Date(Date.now() - 3600000);
    await createIntegration({ projectId: tp1.projectId, nextSyncAt: past });
    await createIntegration({ projectId: tp2.projectId, nextSyncAt: past });

    const queue = getPgBossQueue(
      QueueName.BlobStorageIntegrationProcessingQueue,
    );
    const spy = vi.spyOn(queue, "insertBulk");

    await handleBlobStorageIntegrationSchedule();

    expect(spy).toHaveBeenCalledTimes(1);
    const calls = spy.mock.calls[0][0];
    expect(calls.length).toBe(2);
    const projectIds = calls.map((c: any) => c.payload.projectId);
    expect(projectIds).toContain(tp1.projectId);
    expect(projectIds).toContain(tp2.projectId);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Processing tests — call handleBlobStorageIntegrationProjectJob directly
// ═══════════════════════════════════════════════════════════════════════

describe("Blob Storage Integration — Processing", () => {
  it("skips disabled integration without any export", async () => {
    const tp = await createTestProject();
    await createIntegration({ projectId: tp.projectId, enabled: false });

    await handleBlobStorageIntegrationProjectJob(tp.projectId);

    expect(mocks.storageUploadFileBuffered).not.toHaveBeenCalled();
  });

  it("skips when time window is empty (minTimestamp >= maxTimestamp)", async () => {
    const tp = await createTestProject();
    // lastSyncAt is now → window will be empty (min >= max)
    await createIntegration({
      projectId: tp.projectId,
      lastSyncAt: new Date(),
      exportFrequency: "hourly",
    });

    await handleBlobStorageIntegrationProjectJob(tp.projectId);

    expect(mocks.storageUploadFileBuffered).not.toHaveBeenCalled();
    // lastSyncAt and nextSyncAt should have been updated to break out of catch-up loop
    const updated = await prisma.blobStorageIntegration.findUnique({
      where: { projectId: tp.projectId },
    });
    expect(updated?.lastSyncAt).not.toBeNull();
  });

  it("processes traces + observations + scores export when TRACES_OBSERVATIONS", async () => {
    const tp = await createTestProject();
    // Use FULL_HISTORY mode so queryDoris is called for minTimestamp
    const twoHoursAgo = Date.now() - 2 * 3600000;
    mocks.queryDoris.mockResolvedValue([{ min_timestamp: twoHoursAgo }]);

    await createIntegration({
      projectId: tp.projectId,
      exportMode: "FULL_HISTORY",
      exportFrequency: "daily",
      exportSource: "TRACES_OBSERVATIONS",
    });

    mocks.getTracesForBlobStorageExport.mockImplementation(async function* () {
      yield { id: "t1", name: "test-trace" };
    });
    mocks.getObservationsForBlobStorageExport.mockImplementation(
      async function* () {
        yield { id: "o1" };
      },
    );

    await handleBlobStorageIntegrationProjectJob(tp.projectId);

    expect(mocks.getTracesForBlobStorageExport).toHaveBeenCalled();
    expect(mocks.getObservationsForBlobStorageExport).toHaveBeenCalled();
    expect(mocks.getScoresForBlobStorageExport).toHaveBeenCalled();
    expect(mocks.storageUploadFileBuffered).toHaveBeenCalled();

    const updated = await prisma.blobStorageIntegration.findUnique({
      where: { projectId: tp.projectId },
    });
    expect(updated?.lastSyncAt).not.toBeNull();
    expect(updated?.nextSyncAt).not.toBeNull();
    expect(updated?.lastError).toBeNull();
  });

  it("persists error message on S3 upload failure", async () => {
    const tp = await createTestProject();
    const twoHoursAgo = Date.now() - 2 * 3600000;
    mocks.queryDoris.mockResolvedValue([{ min_timestamp: twoHoursAgo }]);

    await createIntegration({
      projectId: tp.projectId,
      exportMode: "FULL_HISTORY",
      exportFrequency: "daily",
      exportSource: "TRACES_OBSERVATIONS",
    });

    mocks.getTracesForBlobStorageExport.mockImplementation(async function* () {
      yield { id: "t1" };
    });
    mocks.storageUploadFileBuffered.mockRejectedValue(
      new Error("S3 upload failed: access denied"),
    );

    await expect(
      handleBlobStorageIntegrationProjectJob(tp.projectId),
    ).rejects.toThrow("access denied");

    const updated = await prisma.blobStorageIntegration.findUnique({
      where: { projectId: tp.projectId },
    });
    expect(updated?.lastError).toContain("access denied");
    expect(updated?.lastErrorAt).not.toBeNull();
  });

  it("enqueues catch-up job via pg-boss when not yet caught up", async () => {
    const tp = await createTestProject();
    const twoDaysAgo = Date.now() - 2 * 24 * 3600000;
    mocks.queryDoris.mockResolvedValue([{ min_timestamp: twoDaysAgo }]);

    await createIntegration({
      projectId: tp.projectId,
      lastSyncAt: new Date(twoDaysAgo),
      exportMode: "FULL_HISTORY",
      exportFrequency: "daily",
      exportSource: "TRACES_OBSERVATIONS",
    });

    mocks.getTracesForBlobStorageExport.mockImplementation(async function* () {
      yield { id: "t1" };
    });

    // Spy on sendSingleton to verify catch-up re-enqueue
    const queue = getPgBossQueue(
      QueueName.BlobStorageIntegrationProcessingQueue,
    );
    const spy = vi.spyOn(queue, "sendSingleton");

    await handleBlobStorageIntegrationProjectJob(tp.projectId);

    expect(spy).toHaveBeenCalled();
    const [jobName, payload, singletonKey] = spy.mock.calls[0];
    expect(jobName).toBe(QueueJobs.BlobStorageIntegrationProcessingJob);
    expect((payload as any).projectId).toBe(tp.projectId);
    expect(singletonKey).toContain(tp.projectId);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Handler registration
// ═══════════════════════════════════════════════════════════════════════

describe("Blob Storage Integration — Worker registration", () => {
  it("registerBlobStoragePgBossWorkers registers without throwing", async () => {
    await expect(registerBlobStoragePgBossWorkers()).resolves.toBeUndefined();
  });

  it("processing queue can send and receive jobs after registration", async () => {
    const queue = getPgBossQueue(
      QueueName.BlobStorageIntegrationProcessingQueue,
    );

    // Register a worker that captures one job
    const received: string[] = [];
    await queue.registerWorker(
      { pollingIntervalSeconds: 0.5, batchSize: 5 },
      async (jobs) => {
        for (const j of jobs) {
          received.push((j.data as any).payload?.projectId ?? "unknown");
        }
      },
    );

    // Send a test job
    const testPid = `test-pid-${randomUUID().slice(0, 6)}`;
    const id = await queue.send(QueueJobs.BlobStorageIntegrationProcessingJob, {
      projectId: testPid,
    });
    expect(id).toBeTruthy();

    // Wait for consumption
    await new Promise((r) => setTimeout(r, 2000));
    expect(received).toContain(testPid);
  });
});
