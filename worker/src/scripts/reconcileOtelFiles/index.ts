#!/usr/bin/env tsx

/**
 * Otel S3 ↔ ledger reconciliation — the final backstop for every loss
 * window: Redis tail-loss on failover, poison eviction, orphans.
 *
 * Usage (from worker/):
 *   pnpm run reconcile-otel-files                    # dry-run, last 8 days
 *   pnpm run reconcile-otel-files -- --execute       # re-inject "reinject"s
 *   pnpm run reconcile-otel-files -- --window-days 3 --older-than-hours 80
 *   pnpm run reconcile-otel-files -- --dup-check     # duplicate-rate SQL only
 *
 * Classification per S3 file (see classify.ts):
 *   ok        — ledger row exists (completed end-to-end)          → skip
 *   in-flight — no ledger, younger than --older-than-hours        → skip
 *   poisoned  — tracked in otel_poison_jobs                       → manual
 *   reinject  — over-age + registered key still present ⇒ pointer lost
 *               inside the pipeline → DEL registered key, re-register
 *               (--execute only; dry-run just reports)
 *   audit     — over-age, no evidence ⇒ orphan vs expired loss → manual
 *               (auto-reinjection could DUPLICATE an SDK re-sent copy)
 *
 * The re-registered entry carries size/spanCount = 0 (unknown without a
 * download; the grouper's flush timeout ships such entries regardless —
 * sizing precision is irrelevant at reconciliation volumes).
 */

import {
  createNewRedisInstance,
  redisQueueRetryOptions,
  getS3EventStorageClient,
  logger,
  registerOtelFile,
  otelRegisteredKey,
  scanStagedOtelGroups,
  otelPendingOldestAgeMs,
  laneForDesignated,
  getDesignatedProjectIds,
  refreshSplitCache,
  executeDorisProjectFanout,
  queryDoris,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { env as sharedEnv } from "@langfuse/shared/src/env";
import { env } from "../../env";

import { classifyOtelFile, type OtelFileVerdict } from "./classify";
import { candidateGroupingKeys, reinjectionGroupingKey } from "./routing";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const EXECUTE = flag("execute");
const DUP_CHECK_ONLY = flag("dup-check");
const WINDOW_DAYS = Number(arg("window-days") ?? 8);
const OLDER_THAN_MS = Number(arg("older-than-hours") ?? 80) * 3600_000;
const BATCH = 500;

const main = async () => {
  if (DUP_CHECK_ONLY) {
    const projects = await prisma.project.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    const projectIds = projects.map((project) => project.id);
    // Duplicate-rate accounting SQL per recent day.
    for (let d = 0; d < WINDOW_DAYS; d++) {
      const day = new Date(Date.now() - d * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const rows = await executeDorisProjectFanout<{
        total_rows: string;
        distinct_spans: string;
        duplicate_rows: string;
      }>({
        logicalTable: "spans",
        projectIds,
        queryTarget: (target) =>
          queryDoris({
            query: `
              SELECT COUNT(*) AS total_rows,
                COUNT(DISTINCT project_id, trace_id, start_time, span_id) AS distinct_spans,
                COUNT(*) - COUNT(DISTINCT project_id, trace_id, start_time, span_id) AS duplicate_rows
              FROM \`${target.physicalTable}\`
              WHERE project_id IN ({projectIds: Array(String)})
                AND date_trunc(start_time, 'day') = date_trunc({day: DateTime}, 'day')
            `,
            params: { projectIds: target.projectIds, day: `${day} 00:00:00` },
            tags: { feature: "otel-reconcile", kind: "duplicate-check" },
          }),
      });
      const totals = rows.reduce(
        (acc, row) => ({
          total_rows: acc.total_rows + Number(row.total_rows),
          distinct_spans: acc.distinct_spans + Number(row.distinct_spans),
          duplicate_rows: acc.duplicate_rows + Number(row.duplicate_rows),
        }),
        { total_rows: 0, distinct_spans: 0, duplicate_rows: 0 },
      );
      console.log(JSON.stringify({ day, ...totals }));
    }
    return;
  }

  // Age-guard sanity (threshold contract). Read from the SAME
  // env var the DLQ age guard uses — a hardcoded copy here would let the two
  // ends of the "nothing still redrivable may be re-injected" contract drift
  // when the operator retunes LITEFUSE_OTEL_LABEL_KEEP_MS.
  const labelKeepMs = env.LITEFUSE_OTEL_LABEL_KEEP_MS;
  if (OLDER_THAN_MS <= labelKeepMs) {
    throw new Error(
      `--older-than-hours must exceed the DLQ age guard (LITEFUSE_OTEL_LABEL_KEEP_MS = ${labelKeepMs / 3600_000}h): still-redrivable jobs must never be re-injected`,
    );
  }
  if (OLDER_THAN_MS >= sharedEnv.LITEFUSE_OTEL_REGISTERED_TTL_MS) {
    logger.warn(
      "--older-than-hours >= registered-key TTL: the auto-reinject category degenerates (registration evidence expires first); everything unexplained will fall to manual audit",
    );
  }
  const ledgerRetentionMs =
    env.LITEFUSE_OTEL_LEDGER_RETENTION_DAYS * 24 * 3600_000;
  if (OLDER_THAN_MS >= ledgerRetentionMs) {
    throw new Error(
      `--older-than-hours (${OLDER_THAN_MS / 3600_000}h) must stay BELOW the ledger retention (LITEFUSE_OTEL_LEDGER_RETENTION_DAYS = ${env.LITEFUSE_OTEL_LEDGER_RETENTION_DAYS}d): a completed file whose ledger row already expired would classify as reinject and be re-ingested — the backstop would manufacture duplicates`,
    );
  }

  // Same topology-aware factory the pipeline itself uses (connection string /
  // sentinel / cluster / TLS all honored, no ioredis keyPrefix) — a hand-rolled
  // host/port connection would read an empty keyspace on any non-trivial
  // deployment and turn the preflight + classification into fiction.
  const redis = createNewRedisInstance(redisQueueRetryOptions);
  if (!redis) {
    throw new Error("[reconcile] failed to create Redis connection");
  }
  const storage = getS3EventStorageClient(
    sharedEnv.LITEFUSE_S3_EVENT_UPLOAD_BUCKET!,
  );

  // Load the split control rows from PG up front. laneFor/getSplitProjectIds read
  // the tableSplitCache snapshot, which the periodic refresh loop (web+worker
  // boot) fills, but this standalone script never starts that loop.
  await refreshSplitCache();
  // All projects register into a dedicated lane. Derive the known preflight
  // lanes from the control table; per-file classification below derives the
  // exact lane from the S3 path project id.
  const laneKeys = getDesignatedProjectIds()
    .map((pid) => laneForDesignated(pid))
    .filter((k): k is string => Boolean(k));

  // ⓪ Execute-mode preflight: re-injection is only safe against a HEALTHY
  // pipeline. Two disaster shapes make it double-load instead:
  //   - an over-age file whose ORIGINAL entry still sits in pending (grouper
  //     dead for days) → re-injection puts the same fileKey in the list
  //     twice → two groups → two labels;
  //   - a staging manifest stuck for days → re-injected members land in a
  //     new group, then the revived recovery republishes the old manifest.
  // Guards: every shard must have (a) no leftover staging manifests and
  // (b) no pending entry older than the re-inject threshold (oldest-age <
  // threshold ⇒ no over-age file can still be queued).
  if (EXECUTE) {
    for (const key of laneKeys) {
      const staged = await scanStagedOtelGroups({ redis, groupingKey: key });
      if (staged.length > 0) {
        throw new Error(
          `[reconcile] preflight failed: grouping key ${key} has ${staged.length} leftover staging manifest(s) — the pipeline is not healthy; drain recovery first (re-injection against a stuck pipeline double-loads)`,
        );
      }
      const oldestAge = await otelPendingOldestAgeMs({
        redis,
        groupingKey: key,
      });
      if (oldestAge != null && oldestAge >= OLDER_THAN_MS) {
        throw new Error(
          `[reconcile] preflight failed: grouping key ${key} pending backlog is older (${Math.round(oldestAge / 3600_000)}h) than the re-inject threshold — over-age files may still be queued; drain the grouper first`,
        );
      }
    }
  }

  // ① S3 inventory inside the window. COMPLETE listing is the whole point of
  // the backstop — the default listFiles cap (LITEFUSE_S3_LIST_MAX_KEYS) would
  // silently truncate to the lexicographically-first page and certify the
  // rest as never-examined. ~100B per key: even millions of keys fit in RAM.
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
  const prefix = `${sharedEnv.LITEFUSE_S3_EVENT_UPLOAD_PREFIX}otel/`;
  const allFiles = await storage.listFiles(prefix, {
    maxKeys: Number.MAX_SAFE_INTEGER,
  });
  const files = allFiles.filter((f) => f.createdAt.getTime() >= cutoff);
  logger.info(
    `[reconcile] ${allFiles.length} otel file(s) listed, ${files.length} in the last ${WINDOW_DAYS}d window`,
  );

  // ② Poison ledger (rare rows — load once, index by fileKey).
  const poisonRows = await prisma.otelPoisonJob.findMany({
    where: { createdAt: { gte: new Date(cutoff) } },
    select: { fileKeys: true },
  });
  const poisoned = new Set<string>(
    poisonRows.flatMap((r) =>
      Array.isArray(r.fileKeys) ? (r.fileKeys as string[]) : [],
    ),
  );

  // ③ Ledger membership (PG otel_file_ledger; multiple rows per fileKey are
  // possible — reconcile reinjection creates a second (fileKey, groupId)
  // pair — membership only).
  const withLedger = new Set<string>();
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const rows = await prisma.otelFileLedger.findMany({
      where: { fileKey: { in: batch.map((f) => f.file) } },
      select: { fileKey: true },
    });
    for (const r of rows) withLedger.add(r.fileKey);
  }

  // ④ Classify + act.
  const now = Date.now();
  const counts: Record<OtelFileVerdict["verdict"], number> = {
    ok: 0,
    "in-flight": 0,
    poisoned: 0,
    reinject: 0,
    audit: 0,
  };
  for (const f of files) {
    // projectId is encoded in the path: <prefix>otel/<projectId>/...
    const projectId = f.file.slice(prefix.length).split("/")[0] ?? "";
    // Every grouping key this file could live under. All-split ingestion uses
    // only the project lane; this is used for BOTH registered-key evidence and
    // the DEL below.
    const candidates = candidateGroupingKeys(projectId, [], laneForDesignated);
    let hasRegisteredKey = false;
    if (!withLedger.has(f.file)) {
      for (const key of candidates) {
        if ((await redis.exists(otelRegisteredKey(key, f.file))) === 1) {
          hasRegisteredKey = true;
          break;
        }
      }
    }
    const verdict = classifyOtelFile(
      {
        fileKey: f.file,
        createdAtMs: f.createdAt.getTime(),
        hasLedger: withLedger.has(f.file),
        isPoisoned: poisoned.has(f.file),
        hasRegisteredKey,
      },
      { now, olderThanMs: OLDER_THAN_MS },
    );
    counts[verdict.verdict]++;

    if (verdict.verdict === "ok" || verdict.verdict === "in-flight") continue;
    console.log(
      JSON.stringify({ fileKey: f.file, createdAt: f.createdAt, ...verdict }),
    );

    if (verdict.verdict === "reinject" && EXECUTE) {
      // Re-inject into the same pool the live write path uses: a split
      // project's dedicated lane, else a random shard (unchanged).
      const groupingKey = reinjectionGroupingKey(
        projectId,
        [],
        (s) => s[Math.floor(Math.random() * s.length)] as string,
        laneForDesignated,
      );
      // Force re-admission: the registered key would absorb the register as
      // an idempotent no-op (reconciliation × SETNX conflict). DEL
      // under every candidate key so a stale lane/shard key can't block it.
      for (const key of candidates)
        await redis.del(otelRegisteredKey(key, f.file));
      const admitted = await registerOtelFile({
        redis,
        groupingKey,
        ttlMs: sharedEnv.LITEFUSE_OTEL_REGISTERED_TTL_MS,
        entry: {
          v: 1,
          fileKey: f.file,
          size: 0,
          spanCount: 0,
          ts: Date.now(),
          projectId,
        },
      });
      console.log(
        JSON.stringify({ fileKey: f.file, reinjected: admitted, groupingKey }),
      );
    }
  }

  console.log(
    JSON.stringify({
      summary: counts,
      mode: EXECUTE ? "execute" : "dry-run",
      windowDays: WINDOW_DAYS,
      olderThanHours: OLDER_THAN_MS / 3600_000,
    }),
  );
  redis.disconnect();
  await prisma.$disconnect();
};

main().catch((e) => {
  logger.error("[reconcile] failed", e);
  process.exit(1);
});
