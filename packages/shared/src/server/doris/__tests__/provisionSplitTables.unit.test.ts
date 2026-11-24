import { describe, it, expect, beforeEach, vi } from "vitest";

// Drive the Doris client from the test.
const { queryMock, commandMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  commandMock: vi.fn(),
}));
vi.mock("../../repositories/doris", () => ({
  queryDoris: queryMock,
  commandDoris: commandMock,
}));
vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../../env", () => ({
  env: {
    DORIS_DB: "litefuse",
    DORIS_REPLICATION_NUM: 1,
    LITEFUSE_STORAGE_PAGE_SIZE: 131_072,
  },
}));

import {
  getSplitMvStatus,
  getSplitTablesReadiness,
  provisionSplitTablesForProject,
} from "../provisionSplitTables";

const PID = "cmqiwxsca0006pj070fdkn0vd";

beforeEach(() => {
  queryMock.mockReset();
  commandMock.mockReset();
});

describe("getSplitMvStatus", () => {
  it("maps the alter-job State to a status", async () => {
    const mv = `trace_metrics_agg_${PID}`;
    for (const [state, expected] of [
      ["PENDING", "building"],
      ["RUNNING", "building"],
      ["FINISHED", "finished"],
      ["CANCELLED", "cancelled"],
    ] as const) {
      queryMock.mockResolvedValueOnce([{ RollupIndexName: mv, State: state }]);
      expect(await getSplitMvStatus(`spans_${PID}`, mv)).toBe(expected);
    }
  });

  it("falls back to DESC … ALL when no alter job is retained", async () => {
    const mv = `trace_metrics_agg_${PID}`;
    // no alter row → then DESC shows the index → finished
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { IndexName: `spans_${PID}` },
        { IndexName: mv },
      ]);
    expect(await getSplitMvStatus(`spans_${PID}`, mv)).toBe("finished");

    // no alter row, DESC lacks the index → absent
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ IndexName: `spans_${PID}` }]);
    expect(await getSplitMvStatus(`spans_${PID}`, mv)).toBe("absent");
  });
});

describe("provisionSplitTablesForProject (idempotent MV)", () => {
  it("creates both base tables then the MV when absent", async () => {
    queryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]); // MV status: absent
    await provisionSplitTablesForProject({
      projectId: PID,
      retentionDays: null,
    });
    const issued = commandMock.mock.calls.map((c) => c[0].query);
    expect(issued[0]).toContain(`CREATE TABLE IF NOT EXISTS \`spans_${PID}\``);
    expect(issued[0]).toContain('"storage_page_size" = "131072"');
    expect(issued[1]).toContain(
      `CREATE TABLE IF NOT EXISTS \`traces_scalar_${PID}\``,
    );
    // TTL reconcile: ALTER both base tables to the current retention (Option A —
    // so a Project.retentionDays change takes effect on existing tables).
    expect(issued[2]).toContain(`ALTER TABLE \`spans_${PID}\``);
    expect(issued[3]).toContain(`ALTER TABLE \`traces_scalar_${PID}\``);
    expect(issued[4]).toContain(
      `CREATE MATERIALIZED VIEW trace_metrics_agg_${PID}`,
    );
  });

  it("skips the MV CREATE while it is still building (idempotent)", async () => {
    queryMock.mockResolvedValueOnce([
      { RollupIndexName: `trace_metrics_agg_${PID}`, State: "RUNNING" },
    ]);
    await provisionSplitTablesForProject({
      projectId: PID,
      retentionDays: null,
    });
    const issued = commandMock.mock.calls.map((c) => c[0].query);
    expect(issued.some((q) => q.includes("CREATE MATERIALIZED VIEW"))).toBe(
      false,
    );
    // base tables (CREATE ×2) + TTL reconcile (ALTER ×2) still issued
    expect(issued).toHaveLength(4);
  });

  it("re-creates the MV when a prior build was CANCELLED", async () => {
    queryMock.mockResolvedValueOnce([
      { RollupIndexName: `trace_metrics_agg_${PID}`, State: "CANCELLED" },
    ]);
    await provisionSplitTablesForProject({
      projectId: PID,
      retentionDays: null,
    });
    const issued = commandMock.mock.calls.map((c) => c[0].query);
    expect(issued.some((q) => q.includes("CREATE MATERIALIZED VIEW"))).toBe(
      true,
    );
  });
});

describe("getSplitTablesReadiness", () => {
  it("ready only when both tables exist and the MV is finished", async () => {
    // dorisTableExists ef → [row], ts → [row]; then MV status FINISHED
    queryMock
      .mockResolvedValueOnce([{ x: 1 }]) // SHOW TABLES ef
      .mockResolvedValueOnce([{ x: 1 }]) // SHOW TABLES ts
      .mockResolvedValueOnce([
        { RollupIndexName: `trace_metrics_agg_${PID}`, State: "FINISHED" },
      ]);
    const r = await getSplitTablesReadiness(PID);
    expect(r).toEqual({
      ready: true,
      spansExists: true,
      tracesScalarExists: true,
      mvStatus: "finished",
    });
  });

  it("not ready while the MV is still building", async () => {
    queryMock
      .mockResolvedValueOnce([{ x: 1 }])
      .mockResolvedValueOnce([{ x: 1 }])
      .mockResolvedValueOnce([
        { RollupIndexName: `trace_metrics_agg_${PID}`, State: "PENDING" },
      ]);
    const r = await getSplitTablesReadiness(PID);
    expect(r.ready).toBe(false);
    expect(r.mvStatus).toBe("building");
  });
});
