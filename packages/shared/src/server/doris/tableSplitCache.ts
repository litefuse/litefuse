import type { Cluster, Redis } from "ioredis";
import { prisma } from "../../db";
import { logger } from "../logger";
import { createNewRedisInstance } from "../redis/redis";

/**
 * In-memory snapshot of the doris_project_table_split control table.
 *
 * Table names are deterministic in the all-split model, so this cache is only a
 * readiness signal: split=true means the base tables are provisioned and the
 * grouper may cut the project's lane. A miss means "not live yet"; it never
 * means "route telemetry to shared tables".
 *
 * Each refresh atomically swaps in a new snapshot. Failed refreshes keep the
 * last good snapshot, and process startup waits for the first successful load.
 */

// Snapshot of EVERY control row: projectId → split flag.
//   true  = LIVE    (tables provisioned; grouper may cut the lane)
//   false = PENDING (designated, tables being provisioned; writes must be held on
//                    the project's lane, NOT routed to the shared table)
// A missing key = not designated/live yet. Per-project retention is
// single-sourced on Project.retentionDays, deliberately NOT cached.
type SplitSnapshot = ReadonlyMap<string, boolean>;

/** Ingestion routing state for a project (write path). */
export type SplitState = "live" | "pending" | "not_split";

// Next.js bundles the instrumentation hook (which starts the refresh loop — see
// web/src/initialize.ts) and the API routes (which READ the cache) as SEPARATE
// module instances. A plain module-level `let snapshot` would be populated in
// the instrumentation instance but stay null in the API-route instance, so
// isSplitCacheReady() would defer EVERY ingestion ("split-cache not ready").
// Back the state with globalThis — one snapshot per PROCESS, shared across
// instances — the same singleton pattern the prisma client uses (../../db).
const splitCacheGlobal = globalThis as unknown as {
  litefuseDorisSplitSnapshot?: SplitSnapshot | null;
  // Negative cache: projects confirmed (via a PG fallback) to have NO control
  // row. Bounds the PG fallback to ONE lookup per newly-seen project. Cleared on
  // every refresh, so a project designated later is re-evaluated within a cycle.
  litefuseDorisSplitNegative?: Set<string>;
  litefuseDorisSplitRefreshTimer?: ReturnType<typeof setInterval> | null;
};

const getSnapshot = (): SplitSnapshot | null =>
  splitCacheGlobal.litefuseDorisSplitSnapshot ?? null;

const getNegativeCache = (): Set<string> => {
  if (!splitCacheGlobal.litefuseDorisSplitNegative)
    splitCacheGlobal.litefuseDorisSplitNegative = new Set();
  return splitCacheGlobal.litefuseDorisSplitNegative;
};

export const DEFAULT_SPLIT_CACHE_REFRESH_MS = 15_000;

/** Whether the cache has ever successfully loaded (write-path gate). */
export const isSplitCacheReady = (): boolean => getSnapshot() !== null;

/** Sync LIVE test — the hot path behind isSplitProject (reads / group load). */
export const splitProjectInCache = (projectId: string): boolean =>
  getSnapshot()?.get(projectId) === true;

/** All LIVE project ids (the grouper's PG-split lane candidates). Pending lanes
 * accumulate files but are NOT cut until they go live. */
export const getSplitProjectIds = (): string[] => {
  const s = getSnapshot();
  if (!s) return [];
  const out: string[] = [];
  for (const [pid, split] of s) if (split) out.push(pid);
  return out;
};

/** All DESIGNATED project ids (live OR pending). Used by offline reconcile
 * preflight; per-file routing can always derive a deterministic project lane. */
export const getDesignatedProjectIds = (): string[] => {
  const s = getSnapshot();
  return s ? [...s.keys()] : [];
};

/** Sync DESIGNATED test (live OR pending) against the loaded snapshot. */
export const splitProjectDesignatedInCache = (projectId: string): boolean =>
  getSnapshot()?.has(projectId) ?? false;

// Bound the on-demand negative cache; it is never cleared on refresh (the
// snapshot check precedes it, so a later-designated project is superseded
// regardless), so cap its growth for a very-long-lived process.
const NEGATIVE_CACHE_CAP = 100_000;

/**
 * Legacy diagnostic helper for tests and scripts that need to distinguish live
 * vs pending vs absent control rows. The production ingestion path uses
 * ensureProjectSplitDesignated and deterministic project lanes instead.
 */
export const resolveIngestionSplitState = async (
  projectId: string,
): Promise<SplitState> => {
  const snap = getSnapshot();
  if (snap) {
    const v = snap.get(projectId);
    if (v === true) return "live";
    if (v === false) return "pending";
    if (getNegativeCache().has(projectId)) return "not_split";
  }
  // Cache miss → authoritative PG check.
  const row = await prisma.dorisProjectTableSplit.findUnique({
    where: { projectId },
    select: { split: true },
  });
  if (!row) {
    const neg = getNegativeCache();
    if (neg.size >= NEGATIVE_CACHE_CAP) neg.clear();
    neg.add(projectId);
    return "not_split";
  }
  return row.split ? "live" : "pending";
};

/** Load EVERY control row from PG and atomically swap it in; clear the negative
 * cache so newly-designated projects are re-evaluated. */
export const refreshSplitCache = async (): Promise<void> => {
  const rows = await prisma.dorisProjectTableSplit.findMany({
    select: { projectId: true, split: true },
  });
  const next = new Map<string, boolean>();
  for (const r of rows) next.set(r.projectId, r.split);
  splitCacheGlobal.litefuseDorisSplitSnapshot = next;
  // NOTE: the negative cache is deliberately NOT cleared here — the snapshot
  // check in resolveIngestionSplitState precedes the negative check, so a
  // just-designated project is picked up from `next` regardless of a stale
  // negative entry. Clearing every refresh would re-probe PG for every active
  // project without a control row each cycle for no correctness gain.
};

/**
 * Cold-start readiness barrier. A process must not serve reads or start queue
 * consumers until the first authoritative snapshot has loaded successfully.
 */
export const initializeSplitCache = async (
  retryMs: number = 5_000,
): Promise<void> => {
  while (!isSplitCacheReady()) {
    try {
      await refreshSplitCache();
    } catch (error) {
      logger.error("Initial Doris split-cache load failed; retrying", {
        retryMs,
        error,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
    }
  }
};

/**
 * Start the periodic refresh loop (idempotent per process). Call once at web
 * and worker boot when the split mode needs the control table. Primes
 * immediately, then refreshes every intervalMs; a failed tick keeps the last
 * good snapshot and is logged.
 */
export const startSplitCacheRefresh = (
  intervalMs: number = DEFAULT_SPLIT_CACHE_REFRESH_MS,
): void => {
  if (splitCacheGlobal.litefuseDorisSplitRefreshTimer) return;
  const tick = async () => {
    try {
      await refreshSplitCache();
    } catch (e) {
      logger.error(
        "doris split-cache refresh failed (keeping last snapshot)",
        e,
      );
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // Never keep the event loop alive just for the refresh timer.
  timer.unref?.();
  splitCacheGlobal.litefuseDorisSplitRefreshTimer = timer;
  // Eager cross-process invalidation on top of the periodic floor.
  subscribeSplitCacheInvalidation();
};

export const stopSplitCacheRefresh = (): void => {
  if (splitCacheGlobal.litefuseDorisSplitRefreshTimer) {
    clearInterval(splitCacheGlobal.litefuseDorisSplitRefreshTimer);
    splitCacheGlobal.litefuseDorisSplitRefreshTimer = null;
  }
  // Close the dedicated pub/sub connections. stop() is the shutdown hook,
  // and nothing else disconnects these — the worker shutdown closes only the
  // shared `redis`. Leaving them open leaks the connection AND keeps the event
  // loop alive (the subscriber socket is not unref'd), hanging test runners.
  if (subscriber) {
    subscriber.disconnect();
    subscriber = null;
  }
  if (publisher) {
    publisher.disconnect();
    publisher = null;
  }
};

// ---------------------------------------------------------------------------
// Eager invalidation broadcast (Stage 1.2e / 1.3)
// ---------------------------------------------------------------------------
// Periodic refresh alone leaves a ≤interval window where a just-changed control
// row is stale in OTHER processes. A control-table write publishes on this
// channel; every process's subscriber refreshes immediately, closing the
// cross-process window that would otherwise misroute a freshly-split project.

const INVALIDATION_CHANNEL = "litefuse:doris-split-cache:invalidate";
let publisher: Redis | Cluster | null = null;
let subscriber: Redis | Cluster | null = null;

// Best-effort broadcast: the awaited publish is bounded so a Redis outage can
// never wedge the caller. createNewRedisInstance keeps enableOfflineQueue
// (a publish issued before the connection is ready still flushes) AND
// maxRetriesPerRequest:null (never fails) — together those mean an offline
// publish neither rejects nor drops, it BLOCKS. The 15s periodic refresh is the
// correctness floor, so a timed-out/dropped broadcast only costs propagation
// latency, never consistency — blocking on it is pure downside.
const PUBLISH_TIMEOUT_MS = 2_000;

/** Publish an invalidation so every process refreshes its split-cache now. Call
 * after any doris_project_table_split write (designate / flip split / delete).
 * Best-effort and time-bounded — never blocks the caller on a Redis outage. */
export const publishSplitCacheInvalidation = async (): Promise<void> => {
  if (!publisher) {
    publisher = createNewRedisInstance();
  }
  if (!publisher) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), PUBLISH_TIMEOUT_MS);
    timer.unref?.();
  });
  // .catch folds a publish failure — or a LATE rejection after the timeout has
  // already won the race — into a value, so Promise.race never rejects and no
  // unhandled rejection escapes the abandoned publish promise.
  const published = publisher
    .publish(INVALIDATION_CHANNEL, "1")
    .then(() => "ok" as const)
    .catch((e) => {
      logger.error("doris split-cache invalidation publish failed", e);
      return "error" as const;
    });
  const result = await Promise.race([published, timeout]);
  if (timer) clearTimeout(timer);
  if (result === "timeout") {
    logger.warn(
      "doris split-cache invalidation publish timed out (best-effort; 15s refresh backstops)",
    );
  }
};

/** Subscribe to invalidations (dedicated connection — a subscriber cannot run
 * other commands). Idempotent per process; wired into startSplitCacheRefresh. */
export const subscribeSplitCacheInvalidation = (): void => {
  if (subscriber) return;
  // A subscriber must let the SUBSCRIBE queue until the connection is ready
  // (enableOfflineQueue:false would drop it) — it runs no other commands.
  subscriber = createNewRedisInstance();
  if (!subscriber) return;
  subscriber.subscribe(INVALIDATION_CHANNEL, (err) => {
    if (err) {
      logger.error("doris split-cache invalidation subscribe failed", err);
    }
  });
  subscriber.on("message", (channel) => {
    if (channel !== INVALIDATION_CHANNEL) return;
    void refreshSplitCache().catch((e) =>
      logger.error("doris split-cache refresh on invalidation failed", e),
    );
  });
};

/** Test-only: install a snapshot directly (bypasses PG). Entries are
 * [projectId, split] (split=true live, false pending). Also resets the negative
 * cache. */
export const __setSplitSnapshotForTest = (
  entries: ReadonlyArray<[string, boolean]> | null,
): void => {
  splitCacheGlobal.litefuseDorisSplitSnapshot =
    entries === null ? null : new Map(entries);
  splitCacheGlobal.litefuseDorisSplitNegative = new Set();
};
