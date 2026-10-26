import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ZodError } from "zod/v4";

import {
  processOtelGroupJob,
  isDeterministicIngestError,
  type GroupJobDeps,
} from "./otelGroupJobProcessor";
import {
  computeGroupId,
  spansLabelForGroup,
  labelForGroupTable,
  __setSplitSnapshotForTest,
  handleMissingSplitTable,
  getSplitRetentionDays,
  type OtelGroupIngestionEventType,
  type OtelPendingEntryType,
  type StreamLoadBodySource,
} from "@langfuse/shared/src/server";
import { ForbiddenError } from "@langfuse/shared";

// Keep the whole shared barrel real (computeGroupId, labels, split routing,
// __setSplitSnapshotForTest all read/mutate the real module state) — only stub
// the two functions that otherwise hit PG: handleMissingSplitTable (its
// scalar/events missing-table three-way is driven per test) and
// getSplitRetentionDays (retention is single-sourced on Project.retentionDays in
// PG; default to "effectively no TTL" so only the retention test opts into a
// finite window).
vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@langfuse/shared/src/server")>();
  return {
    ...actual,
    handleMissingSplitTable: vi.fn(),
    getSplitRetentionDays: vi.fn(async () => Number.MAX_SAFE_INTEGER),
  };
});

/**
 * Core-orchestration tests for the self-contained group job — the
 * exactly-once semantics (label, scalar delete-protection gate, ledger
 * ordering, error whitelist) with fully faked deps.
 */

const entry = (fileKey: string): OtelPendingEntryType => ({
  v: 1,
  fileKey,
  size: 1000,
  spanCount: 2,
  ts: Date.now(),
  projectId: "p1",
  publicKey: "pk",
});

const eventRecord = (spanId: string, opts: Record<string, unknown> = {}) =>
  ({
    project_id: "p1",
    trace_id: "t1",
    span_id: spanId,
    start_time: Date.now(),
    event_ts: Date.now(),
    is_root: 0,
    ...opts,
  }) as never;

const payloadFor = (
  fileKeys: string[],
): OtelGroupIngestionEventType => ({
  shape: "group-v1",
  groupId: computeGroupId(fileKeys),
  entries: fileKeys.map(entry),
});

type LoadCall = {
  table: string;
  rows: unknown[];
  count: number;
  options: Record<string, unknown>;
};

const decodeBody = (body: StreamLoadBodySource): unknown[] =>
  Buffer.concat([...body.chunks()])
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const makeDeps = (
  overrides: Partial<GroupJobDeps> & {
    dedupedByLabel?: boolean;
    ledger?: boolean;
  } = {},
) => {
  const loads: LoadCall[] = [];
  const deps: GroupJobDeps = {
    downloadFile: vi.fn(async (fileKey: string) => `raw:${fileKey}`),
    transformFile: vi.fn(async (e: OtelPendingEntryType) => ({
      eventRecords: [
        eventRecord(`${e.fileKey}-root`, { is_root: 1, session_id: "s1" }),
        eventRecord(`${e.fileKey}-child`),
      ],
      scalarRecords: [
        { project_id: "p1", id: "t1", start_time: Date.now(), event_ts: Date.now() } as never,
      ],
      sessions: new Map([["s1", "default"]]),
    })),
    streamLoadBody: vi.fn(async (table, body, count, options) => {
      loads.push({ table, rows: decodeBody(body), count, options });
      return {
        dedupedByLabel:
          table.startsWith("spans")
            ? (overrides.dedupedByLabel ?? false)
            : false,
      };
    }),
    ledgerExists: vi.fn(async () => overrides.ledger ?? false),
    // PG completion ledger (moved off Doris — the tiny per-group stream
    // loads were the tablet-version incident trigger). Recorded into the
    // same timeline as loads so ordering assertions still work.
    persistLedger: vi.fn(async ({ groupId, entries }) => {
      loads.push({
        table: "pg:otel_file_ledger",
        rows: entries.map((e: OtelPendingEntryType) => ({
          fileKey: e.fileKey,
          projectId: e.projectId,
          groupId,
        })),
        count: entries.length,
        options: {},
      });
    }),
    upsertSessions: vi.fn(async () => {}),
    transformConcurrency: 2,
    ...overrides,
  };
  return { deps, loads };
};

describe("processOtelGroupJob (core EO semantics)", () => {
  // Prime a ready, empty snapshot so the cache-readiness gate passes. Table
  // routing is deterministic all-split and no longer depends on this snapshot.
  beforeEach(() => __setSplitSnapshotForTest([]));
  afterEach(() => __setSplitSnapshotForTest(null));

  it("happy path: label derivation, ndjson framing, no filter ratio, ledger LAST", async () => {
    const payload = payloadFor(["f1.json", "f2.json"]);
    const { deps, loads } = makeDeps();

    await processOtelGroupJob(payload, deps);

    const [events, scalar, ledger] = loads;
    expect(events.table).toBe("spans_p1");
    expect(events.options.label).toBe(spansLabelForGroup(payload.groupId));
    expect(events.options.format).toBe("json");
    // EO hard rule: silent row-dropping is forbidden.
    expect(events.options).not.toHaveProperty("max_filter_ratio");
    expect(events.rows).toHaveLength(4); // 2 files × 2 records

    // Both Doris loads carry deterministic labels — a group's lifetime FE
    // label-registry footprint is exactly 2 slots regardless of retries
    // (random per-attempt labels flooded the registry and evicted events
    // labels: duplicate-data incident 2026-07-28).
    expect(scalar.table).toBe("traces_scalar_p1");
    expect(scalar.options.label).toBe(
      labelForGroupTable(payload.groupId, "traces_scalar"),
    );

    // Ledger (PG) is written LAST — its existence certifies end-to-end
    // completion.
    expect(ledger.table).toBe("pg:otel_file_ledger");
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0]).toMatchObject({
      fileKey: "f1.json",
      groupId: payload.groupId,
    });
    expect(deps.upsertSessions).toHaveBeenCalledTimes(1);
  });

  it("dedups a fileKey duplicated in the payload", async () => {
    const payload = payloadFor(["f1.json"]);
    payload.entries.push(entry("f1.json")); // defense-in-depth path
    const { deps } = makeDeps();

    await processOtelGroupJob(payload, deps);
    expect(deps.transformFile).toHaveBeenCalledTimes(1);
  });

  it("deterministic transform error dead-letters the FILE, group survives", async () => {
    const payload = payloadFor(["bad.json", "good.json"]);
    const { deps, loads } = makeDeps();
    (deps.transformFile as ReturnType<typeof vi.fn>).mockImplementation(
      async (e: OtelPendingEntryType) => {
        if (e.fileKey === "bad.json") throw new SyntaxError("not json");
        return {
          eventRecords: [eventRecord("ok")],
          scalarRecords: [],
          sessions: new Map(),
        };
      },
    );

    await processOtelGroupJob(payload, deps);
    const events = loads.find((l) => l.table === "spans_p1")!;
    expect(events.rows).toHaveLength(1); // only good.json's record
    // Ledger still covers BOTH files (bad one is dead-lettered, not retried).
    const ledger = loads.find((l) => l.table === "pg:otel_file_ledger")!;
    expect(ledger.rows).toHaveLength(2);
  });

  it("transient transform error fails the WHOLE job (replay owns recovery)", async () => {
    const payload = payloadFor(["f1.json"]);
    const { deps, loads } = makeDeps();
    (deps.transformFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("pg connection reset"),
    );

    await expect(processOtelGroupJob(payload, deps)).rejects.toThrow(
      "pg connection reset",
    );
    expect(loads).toHaveLength(0); // nothing loaded, nothing acked
  });

  it("empty group (all dead-lettered) skips loads but still writes the ledger", async () => {
    const payload = payloadFor(["bad.json"]);
    const { deps, loads } = makeDeps();
    (deps.transformFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ZodError([]),
    );

    await processOtelGroupJob(payload, deps);
    expect(loads.map((l) => l.table)).toEqual(["pg:otel_file_ledger"]);
  });

  it("C6 replay: label deduped + ledger MISSING → scalar MUST be loaded", async () => {
    const payload = payloadFor(["f1.json"]);
    const { deps, loads } = makeDeps({ dedupedByLabel: true, ledger: false });

    await processOtelGroupJob(payload, deps);
    // spans_<pid> was skipped by the FE (dedupedByLabel), but the partial
    // crash (scalar never written) is only distinguishable via the
    // ledger — absent ledger means the scalar load must proceed.
    expect(loads.map((l) => l.table)).toEqual([
      "spans_p1",
      "traces_scalar_p1",
      "pg:otel_file_ledger",
    ]);
  });

  it("D2/B4 late replay: label deduped + ledger EXISTS → scalar skipped (no resurrection)", async () => {
    const payload = payloadFor(["f1.json"]);
    const { deps, loads } = makeDeps({ dedupedByLabel: true, ledger: true });

    await processOtelGroupJob(payload, deps);
    expect(loads.map((l) => l.table)).toEqual([
      "spans_p1",
      "pg:otel_file_ledger",
    ]);
  });

  it("trace_sessions failure fails the job (idempotent replay owns it)", async () => {
    const payload = payloadFor(["f1.json"]);
    const { deps } = makeDeps();
    (deps.upsertSessions as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("pg down"),
    );

    await expect(processOtelGroupJob(payload, deps)).rejects.toThrow("pg down");
  });

  it("download failure fails the job", async () => {
    const payload = payloadFor(["f1.json"]);
    const { deps } = makeDeps();
    (deps.downloadFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("s3 503"),
    );

    await expect(processOtelGroupJob(payload, deps)).rejects.toThrow(
      /download failed/,
    );
  });
});

describe("isDeterministicIngestError", () => {
  it("whitelists parse/schema/forbidden; rejects everything else", () => {
    expect(isDeterministicIngestError(new SyntaxError("x"))).toBe(true);
    expect(isDeterministicIngestError(new ZodError([]))).toBe(true);
    expect(isDeterministicIngestError(new ForbiddenError("gone"))).toBe(true);
    expect(isDeterministicIngestError(new Error("ECONNRESET"))).toBe(false);
    expect(isDeterministicIngestError("string error")).toBe(false);
  });
});

// Split-target routing + retention filter. Table split is universal now, so
// these run in the normal suite: prime the cache snapshot with a LIVE project
// (split=true) and its loads route to the per-project tables. Retention is read
// from PG via the mocked getSplitRetentionDays (default: effectively no TTL).
describe("processOtelGroupJob (split targets)", () => {
  afterEach(() => {
    __setSplitSnapshotForTest(null); // never leak into other tests
    vi.mocked(getSplitRetentionDays).mockResolvedValue(Number.MAX_SAFE_INTEGER);
  });

  it("routes a split project's loads to spans_<pid>/traces_scalar_<pid>", async () => {
    __setSplitSnapshotForTest([["p1", true]]);
    const payload = payloadFor(["f1.json"]);
    const { deps, loads } = makeDeps();
    await processOtelGroupJob(payload, deps);
    const tables = loads
      .filter((l) => l.table !== "pg:otel_file_ledger")
      .map((l) => l.table);
    expect(tables).toContain("spans_p1");
    expect(tables).toContain("traces_scalar_p1");
    expect(tables).not.toContain("spans");
  });

  it("drops over-retention rows before the split load (row dead-letter)", async () => {
    __setSplitSnapshotForTest([["p1", true]]);
    vi.mocked(getSplitRetentionDays).mockResolvedValue(7); // 7d retention
    const payload = payloadFor(["f1.json"]);
    const oldTs = Date.now() - 30 * 86_400_000; // 30d old, retention 7d
    const nowTs = Date.now();
    const { deps, loads } = makeDeps({
      transformFile: vi.fn(async () => ({
        eventRecords: [
          eventRecord("recent", { start_time: nowTs }),
          eventRecord("old", { start_time: oldTs }),
        ],
        scalarRecords: [],
        sessions: new Map(),
      })),
    });
    await processOtelGroupJob(payload, deps);
    const eventsLoad = loads.find((l) => l.table === "spans_p1");
    expect(eventsLoad).toBeDefined();
    // only the in-window row survived
    expect(eventsLoad!.count).toBe(1);
    expect(eventsLoad!.rows).toHaveLength(1);
  });

  it("a project not live in cache still targets its split tables", async () => {
    __setSplitSnapshotForTest([["other", true]]); // p1 NOT split
    const payload = payloadFor(["f1.json"]);
    const { deps, loads } = makeDeps();
    await processOtelGroupJob(payload, deps);
    const tables = loads.map((l) => l.table);
    expect(tables).toContain("spans_p1");
    expect(tables).toContain("traces_scalar_p1");
    expect(tables).not.toContain("spans");
  });
});

// Stage 1: the traces_scalar load must have the SAME missing-table
// three-way as spans. Without it, a scalar table lost AFTER go-live (ops
// DROP / rebuild window / replica loss) means events commit, the scalar load
// throws uncaught, and the job retries to the DLQ forever — events in, scalar
// silently lost, table never reprovisioned.
describe("processOtelGroupJob (Stage 1 #4: scalar missing-table three-way)", () => {
  afterEach(() => {
    __setSplitSnapshotForTest(null);
    vi.mocked(handleMissingSplitTable).mockReset();
  });

  // spans_p1 loads fine; traces_scalar_p1 is gone.
  const scalarMissingDeps = () => {
    const { deps, loads } = makeDeps();
    (deps.streamLoadBody as ReturnType<typeof vi.fn>).mockImplementation(
      async (table, body, count, options) => {
        if (table === "traces_scalar_p1") {
          throw new Error("errCode = 2, Table [traces_scalar_p1] does not exist");
        }
        loads.push({ table, rows: decodeBody(body), count, options });
        return { dedupedByLabel: false };
      },
    );
    return { deps, loads };
  };

  it("reprovision/pg-error → job throws (events committed, ledger withheld so replay heals)", async () => {
    __setSplitSnapshotForTest([["p1", true]]);
    vi.mocked(handleMissingSplitTable).mockResolvedValue("retry");
    const { deps, loads } = scalarMissingDeps();

    await expect(
      processOtelGroupJob(payloadFor(["f1.json"]), deps),
    ).rejects.toThrow(/does not exist/);

    const tables = loads.map((l) => l.table);
    expect(tables).toContain("spans_p1"); // events already committed
    expect(tables).not.toContain("pg:otel_file_ledger"); // ledger withheld → replay re-runs scalar
    expect(handleMissingSplitTable).toHaveBeenCalledWith("p1");
  });

  it("tombstoned project → dead-letter + ledger, NO throw (no infinite retry)", async () => {
    __setSplitSnapshotForTest([["p1", true]]);
    vi.mocked(handleMissingSplitTable).mockResolvedValue("skip");
    const { deps, loads } = scalarMissingDeps();

    await processOtelGroupJob(payloadFor(["f1.json"]), deps); // resolves, no throw

    const tables = loads.map((l) => l.table);
    expect(tables).toContain("spans_p1");
    expect(tables).toContain("pg:otel_file_ledger"); // ledger written → group never resurfaces
  });
});
