import { createHash } from "crypto";
import { Cluster, Redis } from "ioredis";

import { OtelPendingEntry, type OtelPendingEntryType } from "../queues";
import { getQueuePrefix } from "./redis";
import { logger } from "../logger";
import { env } from "../../env";

/**
 * Redis primitives for the otel exactly-once ingestion pipeline:
 *
 *   web  ── REGISTER (idempotent SETNX+RPUSH Lua) ──▶ pending LIST
 *   grouper ── CUT_GROUP (fence → members → staging → LTRIM, one atomic Lua)
 *           ── queue.add(jobId=groupId) ── DEL staging
 *
 * A "grouping key" identifies one pending pipeline — today a BullMQ shard name
 * (shared pool), under table split a per-project lane `lane-<pid>`. The key
 * builders make no shape assumption about it, so both forms work.
 *
 * Key layout: every key of a grouping key shares that key's tag (deployment
 * prefix + grouping key; cluster mode wraps it in {braces} so the multi-key Lua
 * stays on one slot).
 *
 * CONNECTION CONTRACT: the key builders below return FULL key strings —
 * REDIS_KEY_PREFIX is already embedded in the grouping-key tag. They must therefore
 * run on connections WITHOUT an ioredis-level `keyPrefix` (which would
 * prefix a second time and split producers/consumers into disjoint
 * keyspaces). Use getUnprefixedRedis() / createNewRedisInstance(), NEVER the
 * shared `redis` singleton (it sets keyPrefix=REDIS_KEY_PREFIX).
 *
 * All functions take the Redis handle explicitly and stay env-free for
 * sizing/TTL — those parameters come from the caller.
 */

// ---------------------------------------------------------------------------
// Key layout
// ---------------------------------------------------------------------------

/**
 * Base tag for a grouping key's pipeline keys — always unique per grouping key:
 *   no prefix        → "<groupingKey>"
 *   non-cluster+pfx  → "<prefix>:<groupingKey>"   (getQueuePrefix returns the BARE
 *                       prefix in this mode — BullMQ appends the queue name
 *                       itself — so the grouping key must be appended here or
 *                       every grouping key's keys would collide on one string)
 *   cluster          → "{<prefix>:<groupingKey>}" (hash tag from getQueuePrefix)
 */
const groupingTag = (groupingKey: string): string => {
  const prefix = getQueuePrefix(groupingKey);
  if (!prefix) return groupingKey;
  if (env.REDIS_CLUSTER_ENABLED === "true") return prefix;
  return `${prefix}:${groupingKey}`;
};

export const otelPendingListKey = (groupingKey: string) =>
  `${groupingTag(groupingKey)}:otel-pending`;
export const otelGrouperLockKey = (groupingKey: string) =>
  `${groupingTag(groupingKey)}:otel-grouper-lock`;
/**
 * Staging is ONE hash per grouping key: field = groupId, value = manifest JSON.
 * Directory and content are the same structure, so "register the group" and
 * "persist its manifest" are a single HSET (command-level atomic — no
 * dangling directory entry can exist) and cleanup is a single HDEL. HKEYS
 * is the recovery scan.
 */
export const otelStagingHashKey = (groupingKey: string) =>
  `${groupingTag(groupingKey)}:otel-staging`;
export const otelQuarantineKey = (groupingKey: string) =>
  `${groupingTag(groupingKey)}:otel-quarantine`;
export const otelRegisteredKey = (groupingKey: string, fileKey: string) =>
  // sha1 keeps the key short & charset-safe regardless of the S3 path shape.
  `${groupingTag(groupingKey)}:otel-reg:${sha1Hex(fileKey)}`;

/**
 * Global discovery SET of per-project lanes that have received registrations
 * (Stage 1.3). The grouper full-scans (lane-index ∪ PG split list) − tombstones
 * to know which lanes to tick — SMEMBERS is O(lanes), unlike a SCAN over the
 * millions of registration keys. One global key (its own hash slot in cluster
 * mode is fine — every op targets the same key).
 */
export const otelLaneIndexKey = () =>
  `${groupingTag("otel-lane-index")}:otel-lane-index`;

export const sha1Hex = (s: string): string =>
  createHash("sha1").update(s).digest("hex");

/** Deterministic group identity: sha1 over the SORTED member fileKeys. */
export const computeGroupId = (fileKeys: string[]): string =>
  sha1Hex([...fileKeys].sort().join(","));

/**
 * Deterministic stream-load label for a group's load into `table`.
 *
 * BOTH Doris loads of a group job (spans / traces_scalar) use
 * deterministic labels — not only spans. (The completion ledger moved
 * to PG otel_file_ledger and needs no label at all.)
 * The FE label registry is a CAPACITY-bounded shared resource
 * (label_num_threshold, default 2000): random per-attempt labels made every
 * retry burn fresh registry slots (ABORTED transactions occupy slots too),
 * and a sustained retry storm was measured to shrink the registry's memory
 * to ~15 minutes — evicting the events label long before its replay arrived
 * and re-loading a committed batch (duplicate-data incident, 2026-07-28).
 * Deterministic labels cap a group's lifetime registry footprint at exactly
 * 2 slots no matter how often it retries.
 */
export const labelForGroupTable = (groupId: string, table: string): string =>
  `lf2_${sha1Hex(`${groupId}_${table}`)}`;

/** Deterministic stream-load label for a group's spans batch. */
export const spansLabelForGroup = (groupId: string): string =>
  labelForGroupTable(groupId, "spans");

/** Labels a single group burns in the FE registry over its lifetime — one per
 * Doris load (spans + traces_scalar), deterministic so retries reuse them. */
export const LABELS_PER_GROUP = 2;

/**
 * Minimum Doris `label_num_threshold` the FE must be configured with (capacity
 * gate, Stage 1.8). Each group holds LABELS_PER_GROUP labels for
 * the keep window; at a sustained group rate the registry must fit them all, or
 * labels get evicted early and a replay re-loads a committed batch (the
 * 2026-07-28 duplicate-data incident). Total group rate rises with lane count
 * (shared pool + Σ per-project lane cut rates) — plug the measured rate in.
 */
export const requiredLabelNumThreshold = (params: {
  groupsPerSecond: number;
  labelKeepMs: number;
}): number =>
  Math.ceil(
    params.groupsPerSecond * LABELS_PER_GROUP * (params.labelKeepMs / 1000),
  );

// ---------------------------------------------------------------------------
// Lua scripts
// ---------------------------------------------------------------------------

/**
 * Idempotent registration: the fileKey is admitted into the pending list at
 * most once per TTL window. Closes the ioredis in-flight command resend hole
 * (autoResendUnfulfilledCommands re-executes a RPUSH whose reply was lost →
 * duplicate entry → duplicate group membership).
 * KEYS[1]=registered:{fileKey}  KEYS[2]=pending list
 * ARGV[1]=entry JSON  ARGV[2]=ttl ms
 * Returns 1 = newly registered, 0 = already registered (idempotent success).
 */
const REGISTER_LUA = `
if redis.call('SET', KEYS[1], '1', 'NX', 'PX', tonumber(ARGV[2])) then
  redis.call('RPUSH', KEYS[2], ARGV[1])
  return 1
end
return 0
`;

/**
 * Atomic group cut: fence → decide members from the list head → dedup →
 * groupId → persist the staging manifest → SADD staged index → LTRIM.
 *
 * Ordering inside the script is normative:
 *   - staging HSET (directory + manifest in ONE command — no dangling
 *     directory state is representable) BEFORE LTRIM: a partial failure
 *     between them leaves the members BOTH in the manifest and in the list —
 *     the reconcile step (LREM by exact raw entry) converges to the
 *     cut-completed state. The reverse order would drop members with no
 *     manifest = loss.
 *   - Redis Lua is isolation-without-rollback: an error mid-script KEEPS the
 *     writes already made; callers must run reconcile before cutting again.
 *
 * Undecodable entries are moved to the quarantine list (kept, alarmed via the
 * quarantine depth metric) instead of failing the script — a poison head
 * entry must never stall the pipeline.
 *
 * The DISPATCH GATE lives inside the script too (the caller just invokes it
 * every tick): the cut happens only when the head window is "ripe" — byte or
 * row target reached, window full, a poison entry present (must be
 * quarantined promptly), or the oldest valid entry has waited past the flush
 * timeout. Otherwise the script returns nil WITHOUT any write. Keeping the
 * gate atomic with the cut means "what to cut" and "whether to cut" can
 * never desync, and the timeout needs no reproducibility — the decision is
 * persisted the instant it is made.
 *
 * KEYS[1]=lock  KEYS[2]=pending  KEYS[3]=staging hash  KEYS[4]=quarantine
 * ARGV[1]=lock token  ARGV[2]=target source bytes  ARGV[3]=target span rows
 * ARGV[4]=max files per group  ARGV[5]=now epoch-ms  ARGV[6]=flush timeout ms
 * Returns nil (fenced / empty / not ripe / nothing valid) or
 * {groupId, manifestJson}.
 */
const CUT_GROUP_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return nil
end
local maxFiles = tonumber(ARGV[4])
local entries = redis.call('LRANGE', KEYS[2], 0, maxFiles - 1)
if #entries == 0 then
  return nil
end
local targetBytes = tonumber(ARGV[2])
local targetRows = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[5])
local flushMs = tonumber(ARGV[6])
local window = 0
local bytes = 0
local rows = 0
local sawBad = false
local oldestTs = nil
local seen = {}
local fileKeys = {}
local raws = {}
for i, raw in ipairs(entries) do
  window = i
  local ok, entry = pcall(cjson.decode, raw)
  if ok and type(entry) == 'table' and type(entry.fileKey) == 'string'
        and type(entry.size) == 'number' then
    if not seen[entry.fileKey] then
      seen[entry.fileKey] = true
      fileKeys[#fileKeys + 1] = entry.fileKey
      raws[#raws + 1] = raw
      bytes = bytes + entry.size
      rows = rows + (tonumber(entry.spanCount) or 0)
      if oldestTs == nil or (tonumber(entry.ts) or nowMs) < oldestTs then
        oldestTs = tonumber(entry.ts) or nowMs
      end
    end
  else
    sawBad = true
  end
  if bytes >= targetBytes or rows >= targetRows then
    break
  end
end
-- Dispatch gate: cut only when ripe. NO writes before this point.
local timedOut = oldestTs ~= nil and (nowMs - oldestTs) >= flushMs
local ripe = bytes >= targetBytes or rows >= targetRows
  or window >= maxFiles or sawBad or timedOut
if not ripe then
  return nil
end
-- Which trigger fired (precedence: size caps → file cap → corrupt → timeout).
-- Surfaced on the [OtelGrouper] cut line so a timeout-dominated stream (groups
-- consistently below target) is distinguishable from a size/rate-driven one.
local reason
if bytes >= targetBytes then reason = 'bytes'
elseif rows >= targetRows then reason = 'rows'
elseif window >= maxFiles then reason = 'files'
elseif sawBad then reason = 'bad'
else reason = 'timeout' end
-- Quarantine pass (writes start here): move undecodable entries aside so the
-- LTRIM below can consume the whole window without losing them.
if sawBad then
  for i = 1, window do
    local raw = entries[i]
    local ok, entry = pcall(cjson.decode, raw)
    if not (ok and type(entry) == 'table' and type(entry.fileKey) == 'string'
          and type(entry.size) == 'number') then
      redis.call('RPUSH', KEYS[4], raw)
    end
  end
end
if #fileKeys == 0 then
  redis.call('LTRIM', KEYS[2], window, -1)
  return nil
end
table.sort(fileKeys)
local groupId = redis.sha1hex(table.concat(fileKeys, ','))
local manifest = '[' .. table.concat(raws, ',') .. ']'
redis.call('HSET', KEYS[3], groupId, manifest)
redis.call('LTRIM', KEYS[2], window, -1)
return { groupId, manifest, reason }
`;

/**
 * Reconcile after a cut-script error (isolation-without-rollback may have
 * left manifest members still sitting in the pending list): remove each
 * manifest member from the list. Idempotent — absent members are no-ops.
 *
 * HEAD-WINDOW invariant (the whole cost model): manifest members can only
 * ever live in the FIRST windowSize positions of the list —
 *   (a) the cut selected them from the head window (≤ maxFiles entries),
 *   (b) new registrations only RPUSH to the tail (LPUSH is never used),
 *   (c) removals only shift the remaining members left — including a
 *       partially-crashed prior reconcile: the leftover members are still a
 *       head prefix,
 *   (d) reviewed non-threats: the reconciliation tool's re-injection RPUSHes
 *       a NEWLY-built entry (fresh ts) — different bytes, never an LREM
 *       target here; at most ONE manifest can have in-list residue at a time
 *       (recovery-before-cut + dirty-tick); FIFO puts the oldest entries at
 *       the head anyway. Out of contract: manual RPUSH of duplicate bytes,
 *       and LOWERING maxFiles while a leftover manifest from a larger window
 *       might exist.
 * So the scan is LRANGE over that window + per-hit LREM (which also
 * terminates inside the window) — total cost is O(windowSize²) worst-case
 * and INDEPENDENT of the pending depth. The naive per-member LREM scan was
 * O(members × depth): an all-miss reconcile (LTRIM already ran — the common
 * crash shape) against a deep backlog (grouper outage) could block Redis
 * for seconds inside one atomic script.
 *
 * KEYS[1]=pending  ARGV[1]=windowSize  ARGV[2..]=raw manifest entries.
 * Ops note: windowSize is max(current maxFiles, member count) — do not
 * LOWER LITEFUSE_OTEL_GROUP_MAX_FILES while a leftover manifest from a
 * larger window might exist (members beyond the new window would be missed
 * and re-grouped).
 */
const RECONCILE_LUA = `
local members = {}
for i = 2, #ARGV do
  members[ARGV[i]] = true
end
local window = redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
local removed = 0
for _, raw in ipairs(window) do
  if members[raw] then
    removed = removed + redis.call('LREM', KEYS[1], 1, raw)
  end
end
return removed
`;

/**
 * Lease renewal (fence-safe): extend only while we still own the token.
 * KEYS[1]=lock  ARGV[1]=token  ARGV[2]=ttl ms. Returns 1 = still leader.
 */
const RENEW_LEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
  return 1
end
return 0
`;

// ---------------------------------------------------------------------------
// Command registration (ioredis defineCommand caches scripts per connection)
// ---------------------------------------------------------------------------

type RedisHandle = Redis | Cluster;

type PipelineCommands = RedisHandle & {
  otelRegister(
    registeredKey: string,
    pendingKey: string,
    entryJson: string,
    ttlMs: number,
  ): Promise<number>;
  otelCutGroup(
    lockKey: string,
    pendingKey: string,
    stagingHashKey: string,
    quarantineKey: string,
    token: string,
    targetBytes: number,
    targetRows: number,
    maxFiles: number,
    nowMs: number,
    flushMs: number,
  ): Promise<[string, string, string] | null>;
  otelReconcile(
    pendingKey: string,
    windowSize: number,
    ...raws: string[]
  ): Promise<number>;
  otelRenewLease(
    lockKey: string,
    token: string,
    ttlMs: number,
  ): Promise<number>;
};

const ensureCommands = (redis: RedisHandle): PipelineCommands => {
  const r = redis as PipelineCommands;
  if (typeof r.otelRegister !== "function") {
    redis.defineCommand("otelRegister", {
      numberOfKeys: 2,
      lua: REGISTER_LUA,
    });
    redis.defineCommand("otelCutGroup", {
      numberOfKeys: 4,
      lua: CUT_GROUP_LUA,
    });
    redis.defineCommand("otelReconcile", {
      numberOfKeys: 1,
      lua: RECONCILE_LUA,
    });
    redis.defineCommand("otelRenewLease", {
      numberOfKeys: 1,
      lua: RENEW_LEASE_LUA,
    });
  }
  return r;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Idempotently register an uploaded otel file into a grouping key's pending list.
 * Returns true when this call registered the file, false when the fileKey was
 * already registered inside the TTL window (idempotent success — the caller
 * treats both as OK; the reconciliation tool is the only caller that must
 * distinguish and pre-DELETE the registered key to force re-admission).
 */
export const registerOtelFile = async (params: {
  redis: RedisHandle;
  groupingKey: string;
  entry: OtelPendingEntryType;
  ttlMs: number;
}): Promise<boolean> => {
  const { redis, groupingKey, entry, ttlMs } = params;
  const parsed = OtelPendingEntry.parse(entry);
  const result = await ensureCommands(redis).otelRegister(
    otelRegisteredKey(groupingKey, parsed.fileKey),
    otelPendingListKey(groupingKey),
    JSON.stringify(parsed),
    ttlMs,
  );
  return result === 1;
};

/** Add a lane to the discovery index (idempotent SADD) — called at registration. */
export const addLaneToIndex = async (
  redis: RedisHandle,
  lane: string,
): Promise<void> => {
  await redis.sadd(otelLaneIndexKey(), lane);
};

/** All lanes ever registered (grouper full-scan candidate source). */
export const getLaneIndex = async (redis: RedisHandle): Promise<string[]> =>
  redis.smembers(otelLaneIndexKey());

/** Drop a lane from the index (un-split / project deletion cleanup). */
export const removeLaneFromIndex = async (
  redis: RedisHandle,
  lane: string,
): Promise<void> => {
  await redis.srem(otelLaneIndexKey(), lane);
};

/**
 * Which dispatch-gate condition triggered the cut (see CUT_GROUP_LUA).
 * "recovery" is not a live trigger — it tags a manifest republished by crash
 * recovery, whose original trigger was not persisted.
 */
export type OtelCutReason =
  | "bytes"
  | "rows"
  | "files"
  | "bad"
  | "timeout"
  | "recovery";

export type OtelGroupCut = {
  groupId: string;
  entries: OtelPendingEntryType[];
  /** Raw manifest exactly as persisted in staging (reconcile needs it). */
  rawEntries: string[];
  /** The dispatch-gate trigger for this cut. */
  reason: OtelCutReason;
};

/** Parse a staging manifest (JSON array of raw entry objects). */
const parseManifest = (
  manifest: string,
): { entries: OtelPendingEntryType[]; rawEntries: string[] } => {
  const parsedArray: unknown[] = JSON.parse(manifest);
  const entries = parsedArray.map((e) => OtelPendingEntry.parse(e));
  return { entries, rawEntries: entries.map((e) => JSON.stringify(e)) };
};

/**
 * Atomically cut the next group from the grouping key's pending list (see
 * CUT_GROUP_LUA — the dispatch gate is inside). Returns null when fenced
 * (lost the lease), the list is empty, the head window is not ripe yet, or
 * it held nothing valid. Call it every tick; the script decides.
 */
export const cutOtelGroup = async (params: {
  redis: RedisHandle;
  groupingKey: string;
  token: string;
  targetBytes: number;
  targetRows: number;
  maxFiles: number;
  /** Flush timeout: cut a below-target group once its oldest entry waited this long. */
  flushMs: number;
  now?: number;
}): Promise<OtelGroupCut | null> => {
  const {
    redis,
    groupingKey,
    token,
    targetBytes,
    targetRows,
    maxFiles,
    flushMs,
  } = params;
  const result = await ensureCommands(redis).otelCutGroup(
    otelGrouperLockKey(groupingKey),
    otelPendingListKey(groupingKey),
    otelStagingHashKey(groupingKey),
    otelQuarantineKey(groupingKey),
    token,
    targetBytes,
    targetRows,
    maxFiles,
    params.now ?? Date.now(),
    flushMs,
  );
  if (!result) return null;
  const [groupId, manifest, reason] = result;
  const { entries, rawEntries } = parseManifest(manifest);
  return {
    groupId,
    entries,
    rawEntries,
    reason: (reason as OtelCutReason) ?? "timeout",
  };
};

/**
 * Converge the pending list to the cut-completed state after a cut-script
 * error: remove every manifest member still sitting in the list. Must run —
 * for every leftover staging manifest — before the next cut is allowed.
 * `windowSize` bounds the head-window scan (see RECONCILE_LUA): pass the
 * grouper's maxFiles; it is floored at the member count so a manifest can
 * never outsize its own scan window.
 */
export const reconcileOtelPending = async (params: {
  redis: RedisHandle;
  groupingKey: string;
  rawEntries: string[];
  windowSize: number;
}): Promise<number> => {
  const { redis, groupingKey, rawEntries, windowSize } = params;
  if (rawEntries.length === 0) return 0;
  return ensureCommands(redis).otelReconcile(
    otelPendingListKey(groupingKey),
    Math.max(windowSize, rawEntries.length),
    ...rawEntries,
  );
};

/** Try to acquire the grouping key's grouper lease (SET NX PX). */
export const acquireOtelGrouperLease = async (params: {
  redis: RedisHandle;
  groupingKey: string;
  token: string;
  ttlMs: number;
}): Promise<boolean> => {
  const { redis, groupingKey, token, ttlMs } = params;
  const res = await redis.set(
    otelGrouperLockKey(groupingKey),
    token,
    "PX",
    ttlMs,
    "NX",
  );
  return res === "OK";
};

/**
 * Write a grouping key's lock = token (plain SET PX, no NX) — the lane-lock
 * TOKEN CARRIER for the lane domain (Stage 1.4). Mutual exclusion
 * across workers is already guaranteed by the single LANE_DOMAIN_LEASE, so this
 * is NOT a contended lock — it only stamps the current domain leader's token
 * into each lane's lock key so the (unchanged) cut Lua fence `GET lock==token`
 * passes. A leader handover overwrites it, fencing the old leader's late cut.
 */
export const setOtelGrouperLease = async (params: {
  redis: RedisHandle;
  groupingKey: string;
  token: string;
  ttlMs: number;
}): Promise<void> => {
  const { redis, groupingKey, token, ttlMs } = params;
  await redis.set(otelGrouperLockKey(groupingKey), token, "PX", ttlMs);
};

/** Renew the lease iff we still own it (fence-safe). */
export const renewOtelGrouperLease = async (params: {
  redis: RedisHandle;
  groupingKey: string;
  token: string;
  ttlMs: number;
}): Promise<boolean> => {
  const { redis, groupingKey, token, ttlMs } = params;
  const res = await ensureCommands(redis).otelRenewLease(
    otelGrouperLockKey(groupingKey),
    token,
    ttlMs,
  );
  return res === 1;
};

/** List the groupIds with staging manifests (HKEYS — the recovery scan). */
export const scanStagedOtelGroups = async (params: {
  redis: RedisHandle;
  groupingKey: string;
}): Promise<string[]> => {
  return params.redis.hkeys(otelStagingHashKey(params.groupingKey));
};

/**
 * Read one staging manifest. Returns null when the field is gone — with the
 * single-hash design the only benign cause is a concurrent clear between the
 * caller's HKEYS and this HGET (the group was already published); callers
 * just skip it.
 */
export const readOtelStagingManifest = async (params: {
  redis: RedisHandle;
  groupingKey: string;
  groupId: string;
}): Promise<OtelGroupCut | null> => {
  const { redis, groupingKey, groupId } = params;
  const manifest = await redis.hget(otelStagingHashKey(groupingKey), groupId);
  if (manifest == null) return null;
  try {
    const { entries, rawEntries } = parseManifest(manifest);
    return { groupId, entries, rawEntries, reason: "recovery" };
  } catch (e) {
    // A manifest that no longer parses is a bug, but it must not wedge the
    // recovery scan: surface loudly and let the operator inspect the field.
    logger.error(
      `otel staging manifest unparsable (groupId=${groupId}, groupingKey=${groupingKey}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
};

/**
 * Drop a staging manifest after its group job was durably queued. Single
 * HDEL — directory entry and content vanish together, no two-step window.
 */
export const clearOtelStagingManifest = async (params: {
  redis: RedisHandle;
  groupingKey: string;
  groupId: string;
}): Promise<void> => {
  await params.redis.hdel(
    otelStagingHashKey(params.groupingKey),
    params.groupId,
  );
};

/** Depth probes for monitoring (pending backlog / quarantine). */
export const otelPendingDepth = async (params: {
  redis: RedisHandle;
  groupingKey: string;
}): Promise<number> =>
  params.redis.llen(otelPendingListKey(params.groupingKey));

export const otelQuarantineDepth = async (params: {
  redis: RedisHandle;
  groupingKey: string;
}): Promise<number> => params.redis.llen(otelQuarantineKey(params.groupingKey));

/**
 * Age of the OLDEST pending entry (ms), or null when the list is empty.
 * Drives both the grouper's flush-timeout decision and the staleness alarm.
 */
export const otelPendingOldestAgeMs = async (params: {
  redis: RedisHandle;
  groupingKey: string;
  now?: number;
}): Promise<number | null> => {
  const head = await params.redis.lindex(
    otelPendingListKey(params.groupingKey),
    0,
  );
  if (head == null) return null;
  try {
    const entry = OtelPendingEntry.parse(JSON.parse(head));
    return (params.now ?? Date.now()) - entry.ts;
  } catch {
    // Undecodable head: report "infinitely old" so the grouper cuts (and
    // quarantines it) promptly instead of the alarm staying silent.
    return Number.MAX_SAFE_INTEGER;
  }
};
