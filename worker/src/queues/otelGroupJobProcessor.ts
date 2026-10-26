import { ZodError } from "zod/v4";
import pLimit from "p-limit";

import {
  dorisClient,
  spansLabelForGroup,
  labelForGroupTable,
  formatRecordForDoris,
  getS3EventStorageClient,
  logger,
  recordHistogram,
  recordIncrement,
  traceException,
  OtelIngestionProcessor,
  isSplitCacheReady,
  tableFor,
  getSplitRetentionDays,
  handleMissingSplitTable,
  type EventRecordInsertType,
  type OtelGroupIngestionEventType,
  type OtelPendingEntryType,
  type StreamLoadBodySource,
  type StreamLoadOutcome,
  type TraceScalarRecordInsertType,
} from "@langfuse/shared/src/server";
import { ForbiddenError } from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import { env } from "../env";
import { env as sharedEnv } from "@langfuse/shared/src/env";
import { toTraceScalarRecord } from "../services/IngestionService";

/**
 * Self-contained otel group job (exactly-once pipeline): one job = one
 * group = one spans stream load batch = one deterministic label.
 *
 *   download N files → deterministic transform → stream load spans
 *   (label) → stream load traces_scalar (MoW, gated) → fileKey ledger → ack
 *
 * No shared DorisWriter buffer, no refcount handle, no writer-internal
 * retries: BullMQ is the only retry layer (any failure fails the job), the
 * FE label registry / MoW keys are the only idempotency layers, and the
 * processor's return is the only completion signal.
 */

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Whitelist of DETERMINISTIC ingest errors — failures that will recur on
 * every replay of the same input and therefore must be dead-lettered (skipped
 * WITH a searchable record), never retried:
 *   - schema/parse errors (ZodError, JSON SyntaxError),
 *   - ForbiddenError (API key / project no longer exists — a DB lookup that
 *     answered "not found"; infrastructure failures surface as connection
 *     errors, not ForbiddenError).
 * EVERYTHING else — S3/PG/Redis/network/unknown — is presumed transient and
 * must FAIL the job (replay from S3 is free; a swallowed transient error is
 * a silently lost row).
 *
 * DELIBERATELY NOT whitelisted: TypeError/RangeError. They often ARE
 * deterministic (malformed attribute → undefined deref in the transform),
 * but they can equally originate inside infra client code (ioredis/prisma)
 * under transient failure — and misclassifying THAT means silent row loss.
 * The cost asymmetry decides it: a deterministic error treated as transient
 * fails loudly (retries → DLQ → poison ledger + alert, file kept in S3,
 * manual recovery possible — plus, on the legacy per-span path only,
 * label-less retries may duplicate rows, which the DUPLICATE-model table
 * tolerates by design); a transient error treated as deterministic loses
 * rows silently and unrecoverably. Do not widen this list without that
 * trade-off in mind.
 */
export const isDeterministicIngestError = (e: unknown): boolean => {
  if (e instanceof ZodError) return true;
  if (e instanceof SyntaxError) return true;
  if (e instanceof ForbiddenError) return true;
  return false;
};

/** Doris "target table doesn't exist" — the split-table three-way trigger. */
const isMissingTableError = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /does not exist|unknown table|table.*not found|TableNotFound/i.test(m);
};

const deadLetterRow = (params: {
  fileKey: string;
  spanId?: string;
  reason: string;
}): void => {
  // Structured + fixed-field: searchable in the log system, countable in
  // metrics. Row-level loss is EXPLICIT, never silent (design boundary).
  recordIncrement("langfuse.otel_group.row_dead_letter", 1);
  logger.error(
    `event=otel_row_dead_letter fileKey=${params.fileKey}${params.spanId ? ` spanId=${params.spanId}` : ""} reason=${params.reason.slice(0, 500)}`,
  );
};

// ---------------------------------------------------------------------------
// NDJSON body (mirrors DorisWriter's framing: one JSON object per line; the
// chunked source keeps Content-Length exact and avoids a body-sized string)
// ---------------------------------------------------------------------------

const ndjsonBody = (rows: Record<string, unknown>[]): StreamLoadBodySource => {
  const buffers = rows.map((r) =>
    Buffer.from(JSON.stringify(r) + "\n", "utf8"),
  );
  return {
    format: "ndjson",
    byteLength: buffers.reduce((a, b) => a + b.length, 0),
    chunks: () => buffers,
  };
};

// Deliberately minimal: format json + long timeout. NEVER add
// max_filter_ratio here — silently dropping rows breaks exactly-once
// (repositories/doris.ts's option set with max_filter_ratio 0.1 must not
// be copied).
const LOAD_OPTS = { format: "json" as const, timeout: 600 };

// ---------------------------------------------------------------------------
// Rolling per-worker completion stats — backs the periodic
// [OtelGroupJob.health] line (emitted from the grouper tick). Process-local,
// like the load semaphore: each worker reports its OWN in-flight loads +
// completions, so summing the per-replica lines gives the cluster view.
// ---------------------------------------------------------------------------

type GroupJobSample = {
  ts: number;
  /** spans load time, semaphore wait excluded. */
  eventsLoadMs: number;
  eventsMB: number;
  e2eLagMs: number;
  deadFiles: number;
  attempt: number;
};

const groupJobSamples: GroupJobSample[] = [];
// Backstop: the health emitter prunes by time every ~60s, but cap length too
// so a stalled emitter can never grow this unbounded.
const MAX_GROUP_JOB_SAMPLES = 10_000;

const recordGroupJobSample = (sample: GroupJobSample): void => {
  groupJobSamples.push(sample);
  if (groupJobSamples.length > MAX_GROUP_JOB_SAMPLES) {
    groupJobSamples.splice(0, groupJobSamples.length - MAX_GROUP_JOB_SAMPLES);
  }
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

/**
 * Emit one [OtelGroupJob.health] line summarizing THIS worker's group write
 * path over the trailing window: current load-semaphore occupancy plus
 * completion aggregates (throughput, load-ms and e2e-lag percentiles). Called
 * on a ~60s cadence from the grouper tick (which runs on every worker).
 * Consumed samples are pruned as a side effect.
 */
export const emitGroupJobHealth = (
  windowMs = 60_000,
  now = Date.now(),
): void => {
  const cutoff = now - windowMs;
  while (groupJobSamples.length > 0 && groupJobSamples[0].ts < cutoff) {
    groupJobSamples.shift();
  }
  const active = groupJobLoadLimiter.activeCount;
  const pending = groupJobLoadLimiter.pendingCount;
  const loadsPart = `loads=${active}/${env.LITEFUSE_OTEL_LOAD_CONCURRENCY}${pending > 0 ? `(+${pending} queued)` : ""}`;
  const windowSec = Math.round(windowMs / 1000);
  if (groupJobSamples.length === 0) {
    logger.info(
      `[OtelGroupJob.health] ${loadsPart} | last ${windowSec}s: idle (0 groups completed)`,
    );
    return;
  }
  const totalMB = groupJobSamples.reduce((a, s) => a + s.eventsMB, 0);
  const mbps = ((totalMB * 1000) / windowMs).toFixed(1);
  const loadMs = groupJobSamples.map((s) => s.eventsLoadMs);
  const lagSec = groupJobSamples.map((s) => s.e2eLagMs / 1000);
  const dead = groupJobSamples.reduce((a, s) => a + s.deadFiles, 0);
  const retries = groupJobSamples.filter((s) => s.attempt > 1).length;
  logger.info(
    `[OtelGroupJob.health] ${loadsPart} | last ${windowSec}s: groups=${groupJobSamples.length} events=${totalMB.toFixed(1)}MB@${mbps}MB/s | load ms p50=${percentile(loadMs, 0.5)} p95=${percentile(loadMs, 0.95)} | e2e_lag s p50=${percentile(lagSec, 0.5).toFixed(1)} p95=${percentile(lagSec, 0.95).toFixed(1)}${dead > 0 ? ` | dead_files=${dead}` : ""}${retries > 0 ? ` | retries=${retries}` : ""}`,
  );
};

// ---------------------------------------------------------------------------
// Per-file transform (real implementation; tests fake it via deps)
// ---------------------------------------------------------------------------

export type TransformedFile = {
  entry: OtelPendingEntryType;
  eventRecords: EventRecordInsertType[];
  scalarRecords: TraceScalarRecordInsertType[];
  /** distinct sessionId → environment, for the PG trace_sessions upsert */
  sessions: Map<string, string>;
};

export type GroupJobDeps = {
  downloadFile: (fileKey: string) => Promise<string>;
  transformFile: (
    entry: OtelPendingEntryType,
    raw: string,
  ) => Promise<{
    eventRecords: EventRecordInsertType[];
    scalarRecords: TraceScalarRecordInsertType[];
    sessions: Map<string, string>;
  }>;
  streamLoadBody: (
    table: string,
    body: StreamLoadBodySource,
    recordCount: number,
    options: Record<string, unknown>,
    // waitedMs: time this load spent queued on the load semaphore before the
    // actual Doris call. Threaded back so the per-group line can split wall
    // into wait vs load — a saturated semaphore no longer masquerades as a
    // slow Doris (high ms, low MB/s).
  ) => Promise<StreamLoadOutcome & { waitedMs?: number }>;
  ledgerExists: (groupId: string) => Promise<boolean>;
  /** Idempotent PG write of the completion ledger (one row per fileKey). */
  persistLedger: (params: {
    groupId: string;
    entries: OtelPendingEntryType[];
  }) => Promise<void>;
  upsertSessions: (
    sessions: Array<{ id: string; projectId: string; environment: string }>,
  ) => Promise<void>;
  /**
   * Best-effort observation-eval scheduling (side-effect boundary: NOT
   * label-protected, a replay re-schedules). The
   * implementation must swallow its own errors; eval scheduling must never
   * fail the data path.
   */
  scheduleEvals?: (files: TransformedFile[]) => Promise<void>;
  transformConcurrency: number;
};

// ---------------------------------------------------------------------------
// Core (deterministic orchestration — the exactly-once semantics live here)
// ---------------------------------------------------------------------------

export const processOtelGroupJob = async (
  payload: OtelGroupIngestionEventType,
  deps: GroupJobDeps,
  // BullMQ owns all retries (a load never retries internally), so a retry
  // re-runs the WHOLE job — surfaced as attempt=N on the completion line so a
  // slow group that is actually a replay is not mistaken for a slow load.
  ctx?: { attempt?: number },
): Promise<void> => {
  const startedAt = Date.now();
  const { groupId } = payload;

  // Defense-in-depth dedup (registration + cut Lua already dedup; a payload
  // must still never load one file twice inside one label).
  const seen = new Set<string>();
  const entries = payload.entries.filter((e) => {
    if (seen.has(e.fileKey)) return false;
    seen.add(e.fileKey);
    return true;
  });

  // Cache-readiness gate — SYMMETRIC to the web registration gate
  // (OtelIngestionProcessor). The routing below reads isSplitProject from the
  // in-memory snapshot; a COLD/failed cache answers "not split" and would
  // silently load a split project's rows into the SHARED table. Unlike a missing
  // table (which retries via handleMissingSplitTable), the shared table EXISTS —
  // the load succeeds, the label + ledger commit, and a replay dedups → the
  // misroute is permanent (rows invisible to the project's own-table reads).
  // Defer (BullMQ retry) until the snapshot is loaded rather than route blind.
  if (!isSplitCacheReady()) {
    throw new Error(
      "otel group job deferred: split-cache not ready (retry to avoid misrouting a split project to the shared table)",
    );
  }

  // Target tables. A group is homogeneous because ingestion registers every
  // file into its project lane; the target derives from any entry's projectId.
  const targetProjectId = entries[0]?.projectId;
  const split = Boolean(targetProjectId);
  const eventsTable = targetProjectId
    ? tableFor(targetProjectId, "spans")
    : "spans";
  const scalarTable = targetProjectId
    ? tableFor(targetProjectId, "traces_scalar")
    : "traces_scalar";

  // Retention filter: a split table is dynamic_partition — a row older than
  // the project's retention would be
  // committed then silently TTL-dropped. Drop such rows before the load.
  // The cutoff is anchored to the group's newest registration ts (deterministic
  // across replays — I5), not Date.now().
  const retentionDays = split
    ? await getSplitRetentionDays(targetProjectId!)
    : null;
  const nowRef =
    entries.length > 0 ? Math.max(...entries.map((e) => e.ts)) : Date.now();
  const retentionCutoffMs =
    retentionDays != null ? nowRef - retentionDays * 86_400_000 : null;
  let overWindowRows = 0;
  const withinRetention = (startTimeMs: number): boolean => {
    if (retentionCutoffMs === null || startTimeMs >= retentionCutoffMs)
      return true;
    overWindowRows++;
    return false;
  };

  // ① Download + transform under the transform semaphore. Deterministic
  // errors dead-letter the FILE (its rows are skipped, the rest of the group
  // lives on); anything else fails the job → BullMQ replay.
  const limit = pLimit(deps.transformConcurrency);
  const transformed: TransformedFile[] = [];
  // Σ over files (they run concurrently under the transform semaphore, so
  // these can exceed the phase wall — they are for the download-bound vs
  // cpu-bound ratio, not a wall-clock breakdown).
  let downloadMsTotal = 0;
  let transformCpuMsTotal = 0;
  await Promise.all(
    entries.map((entry) =>
      limit(async () => {
        let raw: string;
        try {
          const tDl = Date.now();
          raw = await deps.downloadFile(entry.fileKey);
          downloadMsTotal += Date.now() - tDl;
        } catch (e) {
          // S3 errors are transient by presumption — fail the job.
          throw new Error(
            `otel group ${groupId}: download failed for ${entry.fileKey}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        try {
          const tXform = Date.now();
          const t = await deps.transformFile(entry, raw);
          transformCpuMsTotal += Date.now() - tXform;
          transformed.push({ entry, ...t });
        } catch (e) {
          if (isDeterministicIngestError(e)) {
            deadLetterRow({
              fileKey: entry.fileKey,
              reason:
                e instanceof Error ? `${e.name}: ${e.message}` : String(e),
            });
            return; // file-level dead letter — group continues
          }
          throw e; // transient → fail job → replay
        }
      }),
    ),
  );

  const transformMs = Date.now() - startedAt;
  const deadFiles = entries.length - transformed.length;

  // Memory discipline: a group holds its data THREE ways while loading —
  // record objects (kept for evals/sessions below), formatted Doris rows,
  // and the NDJSON Buffers. The formatted rows and Buffers are each
  // released (nulled) the moment their load returns, so the GC can reclaim
  // them during the remaining (slow, up-to-600s) loads instead of holding
  // ~5-6x the source size until the function exits.
  let eventRows: Record<string, unknown>[] | null = transformed.flatMap((t) =>
    t.eventRecords
      .filter((r) => withinRetention(r.start_time))
      .map((r) => formatRecordForDoris(r, eventsTable)),
  );
  let scalarRows: Record<string, unknown>[] | null = transformed.flatMap((t) =>
    t.scalarRecords
      .filter((r) => withinRetention(r.start_time))
      .map((r) => formatRecordForDoris(r, scalarTable)),
  );
  const eventRowCount = eventRows.length;
  const scalarRowCount = scalarRows.length;
  if (overWindowRows > 0) {
    recordIncrement(
      "langfuse.otel_group.retention_filtered_rows",
      overWindowRows,
    );
    logger.warn(
      `event=otel_retention_filtered group=${groupId.slice(0, 12)} project=${targetProjectId} rows=${overWindowRows} retentionDays=${retentionDays} — rows older than retention dropped before load`,
    );
  }

  // ② Empty group (every file dead-lettered): nothing to load — write the
  // ledger so the files never resurface in reconciliation, and ack.
  // (streamLoadBody would early-return on an empty body; short-circuiting
  // here keeps the gate logic from ever touching that path.)
  if (eventRowCount === 0 && scalarRowCount === 0) {
    await writeLedger(payload, deps);
    logger.warn(
      `[OtelGroupJob] group=${groupId.slice(0, 12)} EMPTY (all ${entries.length} file(s) dead-lettered) — ledger written, nothing loaded`,
    );
    return;
  }

  // ③ spans: the ONE deterministic-label load of this group.
  const label = spansLabelForGroup(groupId);
  let eventsBody = eventRowCount > 0 ? ndjsonBody(eventRows) : null;
  eventRows = null; // Buffers built — the formatted objects are dead weight
  const hadEventsBody = eventsBody !== null;
  const eventsBytes = eventsBody?.byteLength ?? 0;
  const tEvents = Date.now();
  let outcome: StreamLoadOutcome & { waitedMs?: number };
  try {
    outcome = eventsBody
      ? await deps.streamLoadBody(eventsTable, eventsBody, eventRowCount, {
          ...LOAD_OPTS,
          label,
        })
      : { dedupedByLabel: false };
  } catch (e) {
    // "Table doesn't exist" three-way (Stage 1.2d): a split
    // target's table is gone. handleMissingSplitTable classifies via PG —
    // reprovision+retry (live project), pg-error→retry (never guess), or
    // skip (tombstoned project → dead-letter the group so it doesn't retry
    // forever recreating a table the deletion flow is dropping).
    if (split && isMissingTableError(e)) {
      const action = await handleMissingSplitTable(targetProjectId!);
      if (action === "skip") {
        deadLetterRow({
          fileKey: `group:${groupId}`,
          reason: `split tables missing for tombstoned project ${targetProjectId}`,
        });
        await writeLedger(payload, deps);
        return;
      }
    }
    throw e; // transient / reprovision → BullMQ replay
  }
  eventsBody = null; // release the group-sized Buffers before the scalar load
  const eventsMs = Date.now() - tEvents;
  const eventsWaitMs = outcome.waitedMs ?? 0;
  const eventsLoadMs = Math.max(0, eventsMs - eventsWaitMs);

  // ④ traces_scalar (MoW, no label). Delete-protection gate — DUAL condition:
  // skip ONLY when the label deduped AND the ledger already exists. spans
  // commits are VISIBLE immediately, so a replay after a crash between the
  // two loads (spans committed, scalar never written) ALSO sees
  // dedupedByLabel=true — the ledger (written after BOTH loads) is the only
  // signal separating it from a fully-completed run's late replay (which
  // must skip, or a user-deleted trace's scalar row would resurrect).
  let skipScalar = false;
  if (outcome.dedupedByLabel) {
    skipScalar = await deps.ledgerExists(groupId);
    if (skipScalar) {
      recordIncrement("langfuse.otel_group.scalar_gate_skipped", 1);
    }
  }
  const tScalar = Date.now();
  let scalarDeduped = false;
  let scalarWaitMs = 0;
  if (scalarRows && scalarRowCount > 0 && !skipScalar) {
    const scalarBody = ndjsonBody(scalarRows);
    scalarRows = null;
    // Deterministic label (see labelForGroupTable): dedup here is a
    // server-side no-op bonus on top of MoW folding — the DELETE-protection
    // semantics still belong to the ledger gate above, which short-circuits
    // before this load is even attempted.
    try {
      const scalarOutcome = await deps.streamLoadBody(
        scalarTable,
        scalarBody,
        scalarRowCount,
        { ...LOAD_OPTS, label: labelForGroupTable(groupId, "traces_scalar") },
      );
      scalarDeduped = scalarOutcome.dedupedByLabel;
      scalarWaitMs = scalarOutcome.waitedMs ?? 0;
    } catch (e) {
      // Same "table doesn't exist" three-way as the events load (③). Reachable
      // only when traces_scalar_<pid> is lost AFTER go-live (ops DROP, rebuild
      // window, replica loss) — the flip gate keeps split=true from ever being
      // set with a base table missing, so this is never a provisioning race.
      // spans is ALREADY committed here, so on reprovision+retry the
      // replay label-dedups events and the scalar gate (ledger still absent)
      // re-attempts THIS load once the table is back. A tombstoned project →
      // dead-letter + ledger (events already in; the deletion flow drops the
      // rest), so the job doesn't retry forever recreating a table being torn
      // down.
      if (split && isMissingTableError(e)) {
        const action = await handleMissingSplitTable(targetProjectId!);
        if (action === "skip") {
          deadLetterRow({
            fileKey: `group:${groupId}`,
            reason: `scalar table missing for tombstoned project ${targetProjectId}`,
          });
          await writeLedger(payload, deps);
          return;
        }
      }
      throw e; // transient / reprovision → BullMQ replay
    }
  }
  scalarRows = null;
  const scalarMs = Date.now() - tScalar;
  const scalarLoadMs = Math.max(0, scalarMs - scalarWaitMs);

  // ⑤ Side effects BEFORE ack. Eval scheduling is best-effort (impl swallows
  // errors — replays may re-schedule, declared boundary); trace_sessions
  // failures FAIL the job
  // (createMany skipDuplicates is idempotent — replay is free; swallowing
  // the error would 404 session pages forever).
  if (deps.scheduleEvals) await deps.scheduleEvals(transformed);

  // Dedup on (projectId, sessionId) — trace_sessions' composite PK. A group
  // spans projects, and the same sessionId (e.g. a generic "default") can
  // legitimately exist in several of them; keying by sessionId alone would
  // let the last project overwrite the others' rows.
  const sessions = new Map<
    string,
    { id: string; projectId: string; environment: string }
  >();
  for (const t of transformed) {
    for (const [sessionId, environment] of t.sessions) {
      sessions.set(`${t.entry.projectId}\u0000${sessionId}`, {
        id: sessionId,
        projectId: t.entry.projectId,
        environment,
      });
    }
  }
  if (sessions.size > 0) {
    await deps.upsertSessions(Array.from(sessions.values()));
  }

  // ⑥ Ledger LAST (after both loads): its existence certifies "this group
  // completed once end-to-end" — which is exactly what the scalar gate and
  // the reconciliation tool key on.
  const tLedger = Date.now();
  await writeLedger(payload, deps);
  const ledgerMs = Date.now() - tLedger;

  recordIncrement("langfuse.otel_group.jobs_completed", 1);
  recordIncrement("langfuse.otel_group.files_processed", entries.length);
  recordHistogram(
    "langfuse.otel_group.job_duration_ms",
    Date.now() - startedAt,
  );
  if (outcome.dedupedByLabel) {
    recordIncrement("langfuse.otel_group.label_deduped", 1);
  }

  // Per-job performance breakdown — THE line to read for write-throughput
  // questions (one per group, ~0.3/s at target load). e2e_lag = registration
  // of the OLDEST member → fully landed: the true end-to-end ingest latency,
  // covering pending wait + grouping + queue + processing.
  const totalMs = Date.now() - startedAt;
  const eventsMB = eventsBytes / (1024 * 1024);
  const oldestTs = Math.min(...entries.map((e) => e.ts));
  // MB/s is computed off LOAD ms (wall minus semaphore wait) so a saturated
  // load semaphore no longer deflates the reported Doris throughput.
  const mbps = (mb: number, ms: number): string =>
    ms > 0 ? ((mb * 1000) / ms).toFixed(1) : "∞";
  const eventsPart = outcome.dedupedByLabel
    ? "LABEL_DEDUP"
    : hadEventsBody
      ? `wall=${eventsMs}ms(wait=${eventsWaitMs} load=${eventsLoadMs}) ${eventsMB.toFixed(1)}MB ${eventRowCount}rows ${mbps(eventsMB, eventsLoadMs)}MB/s`
      : "none";
  const scalarPart = skipScalar
    ? "SKIPPED(gate)"
    : scalarDeduped
      ? "LABEL_DEDUP"
      : scalarRowCount > 0
        ? `wall=${scalarMs}ms(wait=${scalarWaitMs} load=${scalarLoadMs}) ${scalarRowCount}rows`
        : "none";
  const attemptPart =
    ctx?.attempt && ctx.attempt > 1 ? ` attempt=${ctx.attempt}` : "";
  logger.info(
    `[OtelGroupJob] group=${groupId.slice(0, 12)} files=${entries.length}${deadFiles > 0 ? ` dead_files=${deadFiles}` : ""}${attemptPart} | transform=${transformMs}ms(dl:Σ${downloadMsTotal} xform:Σ${transformCpuMsTotal}) | spans: ${eventsPart} | scalar: ${scalarPart} | ledger=${ledgerMs}ms | total=${totalMs}ms e2e_lag=${((Date.now() - oldestTs) / 1000).toFixed(1)}s`,
  );

  // Feed the trailing-window aggregates behind [OtelGroupJob.health]. Skip
  // label-deduped completions: those are idempotent replays that wrote nothing
  // to Doris, so counting their bytes would inflate the health throughput and
  // their ~0 load ms would skew the load-ms percentiles low.
  if (!outcome.dedupedByLabel) {
    recordGroupJobSample({
      ts: Date.now(),
      eventsLoadMs,
      eventsMB,
      e2eLagMs: Date.now() - oldestTs,
      deadFiles,
      attempt: ctx?.attempt ?? 1,
    });
  }
};

// The ledger lives in POSTGRES (otel_file_ledger), not Doris. Its Doris
// incarnation was a per-group 2-row stream load — tablet versions piled up on
// the tiny table's few tablets and tripped max_tablet_version_num (E-235,
// the 2026-07-28 incident trigger). PG absorbs small frequent inserts
// natively, replays fold via the (file_key, group_id) unique key
// (createMany skipDuplicates), no label needed — and PG is already on this
// job's critical path (upsertSessions precedes the ledger write), so this
// adds zero new failure modes.
const writeLedger = async (
  payload: OtelGroupIngestionEventType,
  deps: GroupJobDeps,
): Promise<void> => {
  await deps.persistLedger({
    groupId: payload.groupId,
    entries: payload.entries,
  });
};

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

export const buildGroupJobDeps = (params: {
  transformFile: GroupJobDeps["transformFile"];
}): GroupJobDeps => {
  const client = dorisClient();
  return {
    downloadFile: (fileKey) =>
      getS3EventStorageClient(
        sharedEnv.LITEFUSE_S3_EVENT_UPLOAD_BUCKET!,
      ).download(fileKey),
    transformFile: params.transformFile,
    // Every load goes through the per-worker load semaphore: global in-flight
    // loads = N workers × LITEFUSE_OTEL_LOAD_CONCURRENCY.
    // Semaphore WAIT is measured separately — it is included in the caller's
    // per-load duration, so without this a saturated semaphore is
    // indistinguishable from a slow Doris (high ms, low MB/s) in the
    // [OtelGroupJob] line.
    streamLoadBody: async (table, body, recordCount, options) => {
      const enqueued = Date.now();
      return groupJobLoadLimiter(async () => {
        const waitedMs = Date.now() - enqueued;
        recordHistogram("langfuse.otel_group.load_semaphore_wait_ms", waitedMs);
        if (waitedMs > 1_000) {
          logger.warn(
            `[OtelGroupJob] load semaphore wait ${waitedMs}ms for ${table} (pending=${groupJobLoadLimiter.pendingCount}) — LITEFUSE_OTEL_LOAD_CONCURRENCY saturated; per-load ms in the job line includes this wait`,
          );
        }
        const outcome = await client.streamLoadBody(
          table,
          body,
          recordCount,
          options,
        );
        // Thread the semaphore wait back so the caller can split wall into
        // wait vs load (the [OtelGroupJob] line does this per table).
        return { ...outcome, waitedMs };
      });
    },
    ledgerExists: async (groupId) => {
      const row = await prisma.otelFileLedger.findFirst({
        where: { groupId },
        select: { id: true },
      });
      return row !== null;
    },
    persistLedger: async ({ groupId, entries }) => {
      await prisma.otelFileLedger.createMany({
        data: entries.map((e) => ({
          projectId: e.projectId,
          fileKey: e.fileKey,
          groupId,
        })),
        skipDuplicates: true,
      });
    },
    upsertSessions: async (sessions) => {
      await prisma.traceSession.createMany({
        data: sessions,
        skipDuplicates: true,
      });
    },
    transformConcurrency: env.LITEFUSE_OTEL_TRANSFORM_CONCURRENCY,
  };
};

/**
 * Real per-file transform: parse → OtelIngestionProcessor.processToEvent →
 * createEventRecord per span (span-level deterministic errors dead-letter
 * the ROW; transform-internal I/O errors — getPrompt/getGenerationUsage hit
 * PG/Redis — propagate and fail the job).
 */
export const buildTransformFile = (params: {
  createEventRecord: (
    eventInput: Record<string, unknown>,
    fileKey: string,
  ) => Promise<EventRecordInsertType>;
}): GroupJobDeps["transformFile"] => {
  return async (entry, raw) => {
    // No SDK-eligibility re-check here: the web OTel route hard-rejects
    // pre-v4 SDKs with a 400 BEFORE upload/registration, so every file in
    // the pipeline (including reconcile re-injections, which lose the SDK
    // header metadata) already passed admission. A worker-side re-check
    // could only misfire and silently drop legitimate replayed files.
    const parsed = JSON.parse(raw); // SyntaxError → deterministic → file dead letter
    const processor = new OtelIngestionProcessor({
      projectId: entry.projectId,
      publicKey: entry.publicKey,
    });
    const eventInputs: Record<string, unknown>[] =
      processor.processToEvent(parsed);

    const eventRecords: EventRecordInsertType[] = [];
    const scalarRecords: TraceScalarRecordInsertType[] = [];
    const sessions = new Map<string, string>();
    for (const input of eventInputs) {
      let record: EventRecordInsertType;
      try {
        record = await params.createEventRecord(input, entry.fileKey);
      } catch (e) {
        if (isDeterministicIngestError(e)) {
          deadLetterRow({
            fileKey: entry.fileKey,
            spanId: String((input as { spanId?: unknown }).spanId ?? ""),
            reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          });
          continue; // row-level dead letter
        }
        throw e; // I/O (PG/Redis) — fail the job
      }
      eventRecords.push(record);
      const scalar = toTraceScalarRecord(record);
      if (scalar) scalarRecords.push(scalar);
      if (record.session_id) {
        sessions.set(record.session_id, record.environment ?? "default");
      }
    }
    return { eventRecords, scalarRecords, sessions };
  };
};

export const groupJobLoadLimiter = pLimit(env.LITEFUSE_OTEL_LOAD_CONCURRENCY);

/** traceException on unexpected paths is owned by the queue-level caller. */
export const wrapGroupJobError = (groupId: string, e: unknown): Error => {
  traceException(e);
  return e instanceof Error
    ? e
    : new Error(`otel group job ${groupId} failed: ${String(e)}`);
};
