/**
 * EO test replay tool (test-cases manual TC-10/11/12; design §4 D2).
 *
 * Deterministic gray-box injection against the OFFICIAL image's pipeline —
 * runs on the host checkout, touches only Redis/BullMQ, never patches the
 * worker under test:
 *
 *   re-register <shard> <fileKey>   — call the idempotent registration Lua 5x
 *                                     with the SAME fileKey; every attempt
 *                                     must return admitted=false (SETNX
 *                                     absorption, TC-10).
 *   re-add-job  <shard> <groupId>   — rebuild a completed group's payload
 *                                     from the Doris ledger and enqueue it
 *                                     with the SAME jobId=groupId: the D2
 *                                     replay (label dedup + scalar gate,
 *                                     TC-11/12). groupId must be the FULL
 *                                     40-char sha1 (logs only print 12).
 *
 * Usage (from worker/): pnpm run eo-replay -- <cmd> <shard> <arg>
 */
import {
  OtelIngestionQueue,
  QueueJobs,
  createNewRedisInstance,
  registerOtelFile,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { env as sharedEnv } from "@langfuse/shared/src/env";

const usage = (): never => {
  console.error(
    [
      "usage:",
      "  pnpm run eo-replay -- re-register <shard> <fileKey>",
      "  pnpm run eo-replay -- re-add-job  <shard> <groupId(full 40-char sha1)>",
      "default shard: otel-ingestion-queue",
    ].join("\n"),
  );
  process.exit(2);
};

// Wrapped in main(): the worker tsc build targets CJS, where a file-level
// top-level await is a compile error.
const main = async () => {
  // pnpm passes the `--` separator through literally — tolerate both forms.
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const [cmd, shard, arg] = argv;
  if (!cmd || !shard || !arg) usage();

  const redis = createNewRedisInstance();
  if (!redis) throw new Error("no redis");

  if (cmd === "re-register") {
    for (let i = 0; i < 5; i++) {
      const admitted = await registerOtelFile({
        redis,
        groupingKey: shard,
        ttlMs: sharedEnv.LITEFUSE_OTEL_REGISTERED_TTL_MS,
        entry: {
          v: 1,
          fileKey: arg,
          size: 0,
          spanCount: 0,
          ts: Date.now(),
          projectId: arg.split("/")[2] ?? "p",
        },
      });
      console.log(`attempt ${i + 1}: admitted=${admitted}`);
    }
  } else if (cmd === "re-add-job") {
    const rows = await prisma.otelFileLedger.findMany({
      where: { groupId: arg },
      select: { fileKey: true, projectId: true },
    });
    const entries = rows.map((r) => ({
      v: 1 as const,
      fileKey: r.fileKey,
      size: 0,
      spanCount: 0,
      ts: Date.now(),
      projectId: r.projectId,
    }));
    if (entries.length === 0) {
      throw new Error(
        `groupId not found in ledger (need the FULL 40-char sha1; logs only print the first 12): ${arg}`,
      );
    }
    const q = OtelIngestionQueue.getInstance({ shardName: shard });
    await q?.add(
      QueueJobs.OtelIngestionJob,
      {
        id: arg,
        timestamp: new Date(),
        name: QueueJobs.OtelIngestionJob,
        payload: { shape: "group-v1", groupId: arg, entries },
      },
      { jobId: arg },
    );
    console.log(`re-added job ${arg} with ${entries.length} entries`);
  } else {
    usage();
  }
  redis.disconnect();
  process.exit(0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
