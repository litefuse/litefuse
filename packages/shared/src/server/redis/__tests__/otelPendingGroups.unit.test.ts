import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  type TestContext,
} from "vitest";
import Redis from "ioredis";
import { randomUUID } from "crypto";

import {
  registerOtelFile,
  requiredLabelNumThreshold,
  LABELS_PER_GROUP,
  addLaneToIndex,
  getLaneIndex,
  removeLaneFromIndex,
  cutOtelGroup,
  reconcileOtelPending,
  acquireOtelGrouperLease,
  renewOtelGrouperLease,
  scanStagedOtelGroups,
  readOtelStagingManifest,
  clearOtelStagingManifest,
  otelPendingDepth,
  otelQuarantineDepth,
  otelPendingOldestAgeMs,
  otelPendingListKey,
  otelStagingHashKey,
  otelQuarantineKey,
  otelGrouperLockKey,
  otelRegisteredKey,
  computeGroupId,
  spansLabelForGroup,
  sha1Hex,
} from "../otelPendingGroups";
import type { OtelPendingEntryType } from "../../queues";

/**
 * These tests exercise the REAL Lua scripts against the dev Redis
 * (infra:dev:up) — Lua atomicity/fencing semantics cannot be mocked
 * meaningfully. Each test run uses a throwaway groupingKey namespace and cleans up
 * after itself; skipped automatically when Redis is unreachable.
 */

const redis = new Redis({
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  port: Number(process.env.REDIS_PORT ?? 6379),
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  password: process.env.REDIS_AUTH || undefined,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});

// Availability probe runs in beforeAll (tsc compiles tests as CJS — no
// top-level await); unavailable Redis skips at RUNTIME via ctx.skip().
let redisUp = false;
beforeAll(async () => {
  try {
    await redis.connect();
    redisUp = (await redis.ping()) === "PONG";
  } catch {
    redisUp = false;
  }
});
afterAll(async () => {
  redis.disconnect();
});

/** it(), but runtime-skipped when the dev Redis is unreachable. */
const itR = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx: TestContext) => {
    if (!redisUp) return ctx.skip();
    await fn();
  });

// Throwaway groupingKey per test for isolation; tracked for cleanup.
const groupingKeys: string[] = [];
const freshGroupingKey = () => {
  const groupingKey = `otel-test-${randomUUID().slice(0, 8)}`;
  groupingKeys.push(groupingKey);
  return groupingKey;
};
afterEach(async () => {
  if (!redisUp) return;
  for (const groupingKey of groupingKeys.splice(0)) {
    const keys = [
      otelPendingListKey(groupingKey),
      otelStagingHashKey(groupingKey),
      otelQuarantineKey(groupingKey),
      otelGrouperLockKey(groupingKey),
    ];
    // registered keys are content-addressed; flush by scanning our namespace.
    const regPattern = `${otelRegisteredKey(groupingKey, "x").split(":otel-reg:")[0]}:otel-reg:*`;
    const regKeys = await redis.keys(regPattern);
    await redis.del(...keys, ...regKeys);
  }
});

const entry = (
  overrides: Partial<OtelPendingEntryType> = {},
): OtelPendingEntryType => ({
  v: 1,
  fileKey: `otel/p1/2026/07/21/${randomUUID()}.json`,
  size: 1000,
  spanCount: 10,
  ts: Date.now(),
  projectId: "p1",
  publicKey: "pk",
  ...overrides,
});

// flushMs: 0 → the dispatch gate always passes (tests drive ripeness
// explicitly where it matters).
const BIG = {
  targetBytes: 1 << 30,
  targetRows: 1 << 30,
  maxFiles: 100,
  flushMs: 0,
};

const cutAsLeader = async (
  groupingKey: string,
  opts: Partial<typeof BIG> = {},
) => {
  const token = randomUUID();
  expect(
    await acquireOtelGrouperLease({ redis, groupingKey, token, ttlMs: 10_000 }),
  ).toBe(true);
  return cutOtelGroup({ redis, groupingKey, token, ...BIG, ...opts });
};

describe("lane-index (discovery SET, Stage 1.3)", () => {
  itR("SADD is idempotent; SMEMBERS lists; SREM removes", async () => {
    const lane = `lane-${randomUUID().slice(0, 8)}`;
    await removeLaneFromIndex(redis, lane);
    await addLaneToIndex(redis, lane);
    await addLaneToIndex(redis, lane); // idempotent
    const idx = await getLaneIndex(redis);
    expect(idx.filter((x) => x === lane)).toHaveLength(1);
    await removeLaneFromIndex(redis, lane);
    expect(await getLaneIndex(redis)).not.toContain(lane);
  });
});

describe("otelPendingGroups (real Redis Lua)", () => {
  describe("registerOtelFile (idempotent registration)", () => {
    itR("registers once and absorbs duplicate registrations", async () => {
      const groupingKey = freshGroupingKey();
      const e = entry();
      expect(
        await registerOtelFile({ redis, groupingKey, entry: e, ttlMs: 60_000 }),
      ).toBe(true);
      // Same fileKey again (client resend / app-level retry) → absorbed.
      expect(
        await registerOtelFile({ redis, groupingKey, entry: e, ttlMs: 60_000 }),
      ).toBe(false);
      expect(await otelPendingDepth({ redis, groupingKey })).toBe(1);
    });
  });

  describe("cutOtelGroup", () => {
    itR(
      "cuts the whole head into one group with deterministic identity",
      async () => {
        const groupingKey = freshGroupingKey();
        const entries = [entry(), entry(), entry()];
        for (const e of entries) {
          await registerOtelFile({
            redis,
            groupingKey,
            entry: e,
            ttlMs: 60_000,
          });
        }

        const cut = await cutAsLeader(groupingKey);
        expect(cut).not.toBeNull();
        expect(cut!.entries.map((e) => e.fileKey).sort()).toEqual(
          entries.map((e) => e.fileKey).sort(),
        );
        // groupId = sha1(sorted fileKeys) — replayable identity.
        expect(cut!.groupId).toBe(
          computeGroupId(entries.map((e) => e.fileKey)),
        );
        expect(spansLabelForGroup(cut!.groupId)).toBe(
          `lf2_${sha1Hex(`${cut!.groupId}_spans`)}`,
        );
        // Manifest persisted, members trimmed off the pending list.
        expect(await scanStagedOtelGroups({ redis, groupingKey })).toEqual([
          cut!.groupId,
        ]);
        const manifest = await readOtelStagingManifest({
          redis,
          groupingKey,
          groupId: cut!.groupId,
        });
        expect(manifest!.entries).toHaveLength(3);
        expect(await otelPendingDepth({ redis, groupingKey })).toBe(0);
      },
    );

    itR("stops at the byte target and leaves the tail in pending", async () => {
      const groupingKey = freshGroupingKey();
      const e1 = entry({ size: 600 });
      const e2 = entry({ size: 600 });
      const e3 = entry({ size: 600 });
      for (const e of [e1, e2, e3]) {
        await registerOtelFile({ redis, groupingKey, entry: e, ttlMs: 60_000 });
      }

      const cut = await cutAsLeader(groupingKey, { targetBytes: 1000 });
      // 600 + 600 >= 1000 → first two form the group, third stays queued.
      expect(cut!.entries.map((e) => e.fileKey)).toEqual([
        e1.fileKey,
        e2.fileKey,
      ]);
      expect(await otelPendingDepth({ redis, groupingKey })).toBe(1);
    });

    itR("dedups a fileKey that slipped into the list twice", async () => {
      const groupingKey = freshGroupingKey();
      const e = entry();
      // Bypass idempotent registration to simulate the raw double-RPUSH.
      await redis.rpush(
        otelPendingListKey(groupingKey),
        JSON.stringify(e),
        JSON.stringify(e),
      );

      const cut = await cutAsLeader(groupingKey);
      expect(cut!.entries).toHaveLength(1);
      // BOTH copies consumed from the list — the duplicate cannot leak into
      // a later group under a different label.
      expect(await otelPendingDepth({ redis, groupingKey })).toBe(0);
    });

    itR(
      "quarantines undecodable entries instead of stalling the groupingKey",
      async () => {
        const groupingKey = freshGroupingKey();
        const good = entry();
        await redis.rpush(otelPendingListKey(groupingKey), "not-json{{{");
        await redis.rpush(
          otelPendingListKey(groupingKey),
          JSON.stringify(good),
        );

        const cut = await cutAsLeader(groupingKey);
        expect(cut!.entries.map((e) => e.fileKey)).toEqual([good.fileKey]);
        expect(await otelQuarantineDepth({ redis, groupingKey })).toBe(1);
        expect(await otelPendingDepth({ redis, groupingKey })).toBe(0);
      },
    );

    itR("is fenced: a stale token writes NOTHING", async () => {
      const groupingKey = freshGroupingKey();
      await registerOtelFile({
        redis,
        groupingKey,
        entry: entry(),
        ttlMs: 60_000,
      });
      const owner = randomUUID();
      expect(
        await acquireOtelGrouperLease({
          redis,
          groupingKey,
          token: owner,
          ttlMs: 10_000,
        }),
      ).toBe(true);

      const fenced = await cutOtelGroup({
        redis,
        groupingKey,
        token: "stale-token",
        ...BIG,
      });
      expect(fenced).toBeNull();
      expect(await otelPendingDepth({ redis, groupingKey })).toBe(1);
      expect(await scanStagedOtelGroups({ redis, groupingKey })).toEqual([]);
    });

    itR("returns null on an empty list", async () => {
      const groupingKey = freshGroupingKey();
      expect(await cutAsLeader(groupingKey)).toBeNull();
    });

    itR("dispatch gate: below-target fresh entries are NOT cut", async () => {
      const groupingKey = freshGroupingKey();
      await registerOtelFile({
        redis,
        groupingKey,
        entry: entry({ size: 10, ts: Date.now() }),
        ttlMs: 60_000,
      });
      // Fresh + tiny + high flush timeout → not ripe → nil, zero writes.
      const cut = await cutAsLeader(groupingKey, { flushMs: 60_000 });
      expect(cut).toBeNull();
      expect(await otelPendingDepth({ redis, groupingKey })).toBe(1);
      expect(await scanStagedOtelGroups({ redis, groupingKey })).toEqual([]);
    });

    itR(
      "dispatch gate: flush timeout ripens a below-target group",
      async () => {
        const groupingKey = freshGroupingKey();
        const e = entry({ size: 10, ts: Date.now() - 5_000 });
        await registerOtelFile({ redis, groupingKey, entry: e, ttlMs: 60_000 });
        // Oldest entry has waited 5s > flushMs 1s → ripe despite tiny size.
        const cut = await cutAsLeader(groupingKey, { flushMs: 1_000 });
        expect(cut!.entries.map((x) => x.fileKey)).toEqual([e.fileKey]);
        expect(await otelPendingDepth({ redis, groupingKey })).toBe(0);
      },
    );
  });

  describe("recovery primitives", () => {
    itR(
      "reconcile removes manifest members still sitting in pending",
      async () => {
        const groupingKey = freshGroupingKey();
        const e1 = entry();
        const e2 = entry();
        const raws = [JSON.stringify(e1), JSON.stringify(e2)];
        // Simulate the isolation-without-rollback residue: manifest exists AND
        // the members are still in the list (LTRIM never ran).
        await redis.rpush(otelPendingListKey(groupingKey), ...raws);

        const removed = await reconcileOtelPending({
          redis,
          groupingKey,
          rawEntries: raws,
          windowSize: 100,
        });
        expect(removed).toBe(2);
        expect(await otelPendingDepth({ redis, groupingKey })).toBe(0);
        // Idempotent: a second reconcile is a no-op.
        expect(
          await reconcileOtelPending({
            redis,
            groupingKey,
            rawEntries: raws,
            windowSize: 100,
          }),
        ).toBe(0);
      },
    );

    itR(
      "reconcile scans ONLY the head window — deep backlog stays untouched",
      async () => {
        const groupingKey = freshGroupingKey();
        // Residue prefix (2 members) + a deep tail of unrelated new arrivals.
        const m1 = entry();
        const m2 = entry();
        const raws = [JSON.stringify(m1), JSON.stringify(m2)];
        const tail = Array.from({ length: 500 }, () => JSON.stringify(entry()));
        await redis.rpush(otelPendingListKey(groupingKey), ...raws, ...tail);

        const removed = await reconcileOtelPending({
          redis,
          groupingKey,
          rawEntries: raws,
          windowSize: 10, // tiny window: proves the tail is never scanned
        });
        expect(removed).toBe(2);
        expect(await otelPendingDepth({ redis, groupingKey })).toBe(500);

        // All-miss reconcile (the common crash shape: LTRIM already ran) against
        // the same deep list: bounded head scan, zero removals, tail intact.
        const missRaws = [JSON.stringify(entry()), JSON.stringify(entry())];
        expect(
          await reconcileOtelPending({
            redis,
            groupingKey,
            rawEntries: missRaws,
            windowSize: 10,
          }),
        ).toBe(0);
        expect(await otelPendingDepth({ redis, groupingKey })).toBe(500);
      },
    );

    itR(
      "reading an absent manifest returns null (concurrent-clear race)",
      async () => {
        const groupingKey = freshGroupingKey();
        expect(
          await readOtelStagingManifest({
            redis,
            groupingKey,
            groupId: "already-cleared-group",
          }),
        ).toBeNull();
      },
    );

    itR("clearOtelStagingManifest drops manifest and index entry", async () => {
      const groupingKey = freshGroupingKey();
      await registerOtelFile({
        redis,
        groupingKey,
        entry: entry(),
        ttlMs: 60_000,
      });
      const cut = await cutAsLeader(groupingKey);
      await clearOtelStagingManifest({
        redis,
        groupingKey,
        groupId: cut!.groupId,
      });
      expect(await scanStagedOtelGroups({ redis, groupingKey })).toEqual([]);
      expect(
        await readOtelStagingManifest({
          redis,
          groupingKey,
          groupId: cut!.groupId,
        }),
      ).toBeNull();
    });
  });

  describe("lease", () => {
    itR("single owner, fence-safe renewal", async () => {
      const groupingKey = freshGroupingKey();
      const a = randomUUID();
      const b = randomUUID();
      expect(
        await acquireOtelGrouperLease({
          redis,
          groupingKey,
          token: a,
          ttlMs: 5_000,
        }),
      ).toBe(true);
      expect(
        await acquireOtelGrouperLease({
          redis,
          groupingKey,
          token: b,
          ttlMs: 5_000,
        }),
      ).toBe(false);
      expect(
        await renewOtelGrouperLease({
          redis,
          groupingKey,
          token: a,
          ttlMs: 5_000,
        }),
      ).toBe(true);
      expect(
        await renewOtelGrouperLease({
          redis,
          groupingKey,
          token: b,
          ttlMs: 5_000,
        }),
      ).toBe(false);
    });
  });

  describe("monitoring probes", () => {
    itR(
      "oldest-age: null when empty, ~age when populated, MAX for poison head",
      async () => {
        const groupingKey = freshGroupingKey();
        expect(await otelPendingOldestAgeMs({ redis, groupingKey })).toBeNull();

        const e = entry({ ts: Date.now() - 5_000 });
        await registerOtelFile({ redis, groupingKey, entry: e, ttlMs: 60_000 });
        const age = await otelPendingOldestAgeMs({ redis, groupingKey });
        expect(age).toBeGreaterThanOrEqual(5_000);
        expect(age).toBeLessThan(60_000);

        const poisoned = freshGroupingKey();
        await redis.rpush(otelPendingListKey(poisoned), "garbage");
        expect(
          await otelPendingOldestAgeMs({ redis, groupingKey: poisoned }),
        ).toBe(Number.MAX_SAFE_INTEGER);
      },
    );
  });
});

describe("requiredLabelNumThreshold (capacity gate, Stage 1.8)", () => {
  it("= ceil(groupsPerSecond × 2 × labelKeepSeconds)", () => {
    // 0.5 groups/s, 2 labels/group, 3-day keep window
    const keepMs = 3 * 24 * 3600_000;
    expect(
      requiredLabelNumThreshold({ groupsPerSecond: 0.5, labelKeepMs: keepMs }),
    ).toBe(Math.ceil(0.5 * LABELS_PER_GROUP * (keepMs / 1000)));
  });
  it("scales linearly with group rate (lane count raises it)", () => {
    const keepMs = 3600_000; // 1h
    const a = requiredLabelNumThreshold({
      groupsPerSecond: 1,
      labelKeepMs: keepMs,
    });
    const b = requiredLabelNumThreshold({
      groupsPerSecond: 2,
      labelKeepMs: keepMs,
    });
    expect(b).toBe(2 * a);
  });
});
