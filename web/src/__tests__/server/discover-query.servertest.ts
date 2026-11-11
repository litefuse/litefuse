import { type NextApiRequest, type NextApiResponse } from "next";
import type * as TRPC from "@trpc/server";
import { createMocks } from "node-mocks-http";
import { prisma } from "@langfuse/shared/src/db";
import { env } from "@langfuse/shared/src/env";
import { dorisClient } from "@langfuse/shared/src/server";
import { DB } from "@/src/server/db";
import queryHandler from "@/src/pages/api/project/[projectId]/discover-query";
import metadataHandler from "@/src/pages/api/project/[projectId]/discover-metadata";
import { discoverRouter } from "@/src/features/discover/server/discoverRouter";
import {
  getQueryTableChartsSQL,
  getQueryTableResultCountSQL,
  getQueryTableResultSQL,
} from "@/src/features/discover/services/sql";
import {
  buildTraceAggSQLFromParams,
  getQueryTableTraceSQL,
} from "@/src/features/discover/services/traces.sql";
import {
  IntervalEnum,
  type QueryTableDataParams,
} from "@/src/features/discover/types/type";

const projectId = "project123";
const database = env.DORIS_DB;
const table = `spans_${projectId}`;
const mockQuery = jest.fn();
const caller = discoverRouter.createCaller({
  session: null,
  headers: {},
  prisma,
  DB,
});

jest.mock("next-auth", () => ({
  getServerSession: jest.fn().mockResolvedValue({ user: {} }),
}));
jest.mock("@/src/server/auth", () => ({ getAuthOptions: jest.fn() }));
jest.mock("@/src/server/utils/checkProjectMembershipOrAdmin", () => ({
  isProjectMemberOrAdmin: jest.fn().mockReturnValue(true),
}));
jest.mock("@/src/server/api/trpc", () => {
  const { initTRPC } = jest.requireActual<typeof TRPC>("@trpc/server");
  const t = initTRPC.create();
  return { createTRPCRouter: t.router, protectedProjectProcedure: t.procedure };
});
jest.mock("@langfuse/shared/src/server", () => ({
  dorisClient: jest.fn(() => ({ query: mockQuery })),
  tableFor: (projectId: string, logical: string) => `${logical}_${projectId}`,
  metricsAggTableFor: (projectId: string) => `trace_metrics_agg_${projectId}`,
  logger: { debug: jest.fn(), error: jest.fn() },
}));

function request(body: object) {
  return createMocks<NextApiRequest, NextApiResponse>({
    method: "POST",
    query: { projectId },
    body,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([]);
});

describe("Discover query authorization", () => {
  it("rejects SQL metadata commands before opening a Doris client", async () => {
    const { req, res } = request({
      queries: [{ refId: "A", rawSql: "SHOW DATABASES" }],
    });

    await queryHandler(req, res);

    expect(dorisClient).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({ results: { A: { frames: [] } } });
  });

  it("executes authorized entries in a mixed Grafana batch", async () => {
    mockQuery.mockResolvedValue([{ id: "test" }]);
    const { req, res } = request({
      queries: [
        { refId: "A", rawSql: `SELECT id FROM ${table}` },
        { refId: "B", rawSql: "SELECT id FROM spans_other_project" },
      ],
    });

    await queryHandler(req, res);

    expect(dorisClient).toHaveBeenCalledTimes(1);
    expect(dorisClient).toHaveBeenCalledWith({ database });
    expect(mockQuery).toHaveBeenCalledWith(
      `SELECT \`id\` FROM \`internal\`.\`${database}\`.\`${table}\``,
    );
    expect(res._getJSONData()).toEqual({
      results: {
        A: {
          frames: [
            {
              schema: { fields: [{ name: "id", type: "string" }] },
              data: { values: [["test"]] },
            },
          ],
        },
        B: { frames: [] },
      },
    });
  });

  it.each([
    "SELECT 1; SELECT 2",
    "SELECT 1 INTO OUTFILE",
    "SELECT * FROM spans",
    "SELECT * FROM Traces_scalar_other",
    "SELECT * FROM information_schema.tables",
    "SELECT * FROM (SELECT * FROM spans_other) AS sample",
    `SELECT * FROM ${table} JOIN spans_other ON 1 = 1`,
    `SELECT * FROM ${table}, spans_other`,
    `SELECT * FROM ${table} UNION ALL SELECT * FROM spans_other`,
    "WITH sample AS (SELECT * FROM spans_other) SELECT * FROM sample",
    "SELECT * FROM numbers()",
    "USE unrelated; SELECT 1",
  ])("rejects unauthorized tRPC SQL before execution (%s)", async (rawSql) => {
    await expect(caller.query({ projectId, rawSql })).rejects.toMatchObject({
      code: expect.stringMatching(/^(BAD_REQUEST|FORBIDDEN)$/),
    });
    expect(dorisClient).not.toHaveBeenCalled();
  });

  it("rejects a separately supplied database in tRPC", async () => {
    await expect(
      caller.query({ projectId, rawSql: "SELECT 1", database: "unrelated" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dorisClient).not.toHaveBeenCalled();
  });

  it("validates the legacy database prefix and executes only the SELECT", async () => {
    const source = `\`internal\`.\`${database}\`.\`${table}\``;
    await caller.query({
      projectId,
      rawSql: `USE \`${database}\`; SELECT id FROM ${source};`,
    });
    expect(mockQuery).toHaveBeenCalledWith(`SELECT \`id\` FROM ${source}`);
  });

  it("scopes each shared table before evaluating joins and caller filters", async () => {
    await caller.query({
      projectId,
      rawSql:
        "WITH s AS (SELECT * FROM scores) SELECT s.* FROM s JOIN scores t ON s.id = t.id WHERE 1 = 1 OR 1 = 0",
    });

    const scoped = `(SELECT * FROM \`internal\`.\`${database}\`.\`scores\` WHERE project_id = '${projectId}')`;
    expect(mockQuery).toHaveBeenCalledWith(
      `WITH \`s\` AS (SELECT * FROM ${scoped} AS \`scores\`) SELECT \`s\` . * FROM \`s\` JOIN ${scoped} AS \`t\` ON \`s\` . \`id\` = \`t\` . \`id\` WHERE 1 = 1 OR 1 = 0`,
    );
  });

  it("accepts the SQL generated for Discover results, counts, charts and traces", async () => {
    const params: QueryTableDataParams = {
      database,
      table,
      catalog: "internal",
      cluster: "",
      timeField: "timestamp",
      startDate: "2026-01-01 00:00:00",
      endDate: "2026-01-02 00:00:00",
      sort: "DESC",
      search_type: "Lucene",
      search_value: "",
      lucene_where: "attributes['message'] MATCH_ANY 'where; from'",
      data_filters: [],
      interval: IntervalEnum.Hour,
      interval_value: 1,
      page: "1",
      page_size: 10,
    };

    const queries = [
      getQueryTableResultSQL(params),
      getQueryTableResultCountSQL(params),
      getQueryTableChartsSQL(params),
      buildTraceAggSQLFromParams({ ...params, page: 1 }),
      getQueryTableTraceSQL({ database, table, trace_id: "trace1" }),
    ];

    for (const rawSql of queries) {
      await expect(
        caller.query({ projectId, database, rawSql }),
      ).resolves.toEqual({ rows: [] });
    }
    expect(mockQuery).toHaveBeenCalledTimes(queries.length);
  });
});

describe("Discover metadata authorization", () => {
  it("only lists tables available to the requesting project", async () => {
    const tables = [
      table,
      `traces_scalar_${projectId}`,
      `trace_metrics_agg_${projectId}`,
      "scores",
    ];
    const ownRows = tables.map((name) => ({ Table: name }));
    mockQuery.mockResolvedValue([
      ...ownRows,
      { Table: "spans" },
      { Table: "traces_scalar_other" },
      { Table: "unrelated" },
    ]);
    const { req, res } = request({ action: "tables", database });

    await metadataHandler(req, res);

    expect(res._getJSONData()).toEqual({ rows: ownRows });
  });

  it("denies metadata for foreign tables and databases before execution", async () => {
    await expect(
      caller.fields({ projectId, database, table: "spans_other" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { req, res } = request({
      action: "indexes",
      database: "unrelated",
      table,
    });
    await metadataHandler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(dorisClient).not.toHaveBeenCalled();
  });

  it("allows field and index lookups for the project's table", async () => {
    mockQuery.mockResolvedValue([{ Field: "timestamp", Type: "datetime(3)" }]);
    await expect(
      caller.fields({ projectId, database, table }),
    ).resolves.toEqual({
      rows: [{ Field: "timestamp", Type: "datetime(3)" }],
    });
    await caller.indexes({ projectId, database, table });
    const source = `\`${database}\`.\`${table}\``;
    expect(mockQuery).toHaveBeenNthCalledWith(1, `SHOW COLUMNS FROM ${source}`);
    expect(mockQuery).toHaveBeenNthCalledWith(2, `SHOW INDEXES FROM ${source}`);
  });
});
