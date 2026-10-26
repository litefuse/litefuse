/** @jest-environment node */

// Server tests for `GET /api/public/v3/scores` — the scores list contract
// ported from upstream Langfuse 4.56.0
// (`web/src/pages/api/public/v3/scores/index.ts` +
// `packages/shared/src/features/scores/interfaces/api/v3/**`).
//
// The route handler is invoked in-process (no HTTP server, no worker), the real
// API-key auth path and the real request/response schemas run, and the rows are
// seeded straight into the Doris `scores` table — the same seeding approach the
// existing `score-filter-service.servertest.ts` uses, because this fork has no
// ClickHouse-style `createScoresCh` helper. Each test creates its own org,
// project and API key and uses a fresh project id, so cases stay independent
// and parallel-safe; no `pruneDatabase` call is used here
// (`web/src/__tests__/server` must not prune). Seeded rows are keyed by their
// unique project id, matching the other Doris-backed server tests that leave
// their telemetry rows in place.

import { randomUUID } from "crypto";
import { createMocks, type RequestOptions } from "node-mocks-http";
import { type NextApiRequest, type NextApiResponse } from "next";
import {
  commandDoris,
  createOrgProjectAndApiKey,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { GetScoresResponseV3 } from "@langfuse/shared";

// The CORS middleware is irrelevant here and its `runMiddleware` wrapper only
// adds noise to the mocked request/response pair.
jest.mock("../../features/public-api/server/cors", () => ({
  __esModule: true,
  cors: (_req: unknown, _res: unknown, next: () => void) => next(),
  runMiddleware: jest.fn(async () => undefined),
}));

import scoresV3Handler from "@/src/pages/api/public/v3/scores/index";

type NextHandler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

async function callGet(params: {
  query?: Record<string, string>;
  auth?: string;
}) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: "GET",
    headers: params.auth ? { authorization: params.auth } : {},
    query: params.query ?? {},
  } as unknown as RequestOptions);

  await (scoresV3Handler as NextHandler)(req, res);

  return {
    status: res._getStatusCode(),
    body: res._getJSONData() as Record<string, unknown>,
  };
}

const dt = (date: Date) =>
  date.toISOString().replace("T", " ").replace("Z", "");
const d = (date: Date) => date.toISOString().slice(0, 10);

type SeedScore = {
  id: string;
  name: string;
  dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL" | "TEXT" | "CORRECTION";
  value: number;
  stringValue?: string | null;
  longStringValue?: string | null;
  source?: string;
  comment?: string | null;
  metadata?: Record<string, string> | null;
  traceId?: string | null;
  observationId?: string | null;
  sessionId?: string | null;
  datasetRunId?: string | null;
  environment?: string;
  authorUserId?: string | null;
  queueId?: string | null;
  timestamp: Date;
};

const lit = (value: string | null | undefined) =>
  value === null || value === undefined
    ? "NULL"
    : `'${value.replace(/'/g, "''")}'`;

const seedScore = async (projectId: string, score: SeedScore) => {
  const metadataLiteral = score.metadata
    ? `map(${Object.entries(score.metadata)
        .map(([k, v]) => `${lit(k)}, ${lit(v)}`)
        .join(", ")})`
    : "NULL";
  await commandDoris({
    query: `INSERT INTO scores
      (project_id, timestamp_date, id, timestamp, trace_id, observation_id, session_id, dataset_run_id,
       name, value, string_value, long_string_value, data_type, source, comment, metadata,
       author_user_id, queue_id, environment, event_ts, created_at, updated_at, is_deleted)
      VALUES
      ('${projectId}', '${d(score.timestamp)}', '${score.id}', '${dt(score.timestamp)}',
       ${lit(score.traceId ?? null)}, ${lit(score.observationId ?? null)}, ${lit(score.sessionId ?? null)},
       ${lit(score.datasetRunId ?? null)}, ${lit(score.name)}, ${score.value},
       ${lit(score.stringValue ?? null)}, ${lit(score.longStringValue ?? "")}, '${score.dataType}',
       '${score.source ?? "API"}', ${lit(score.comment ?? null)}, ${metadataLiteral},
       ${lit(score.authorUserId ?? null)}, ${lit(score.queueId ?? null)}, '${score.environment ?? "default"}',
       '${dt(score.timestamp)}', '${dt(score.timestamp)}', '${dt(score.timestamp)}', 0)`,
  });
};

describe("GET /api/public/v3/scores", () => {
  const createdProjectIds: string[] = [];
  const createdOrgIds: string[] = [];

  const newProject = async () => {
    const { auth, projectId, orgId } = await createOrgProjectAndApiKey();
    createdProjectIds.push(projectId);
    createdOrgIds.push(orgId);
    return { auth, projectId };
  };

  afterAll(async () => {
    if (createdProjectIds.length > 0) {
      await prisma.project.deleteMany({
        where: { id: { in: createdProjectIds } },
      });
    }
    if (createdOrgIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { id: { in: createdOrgIds } },
      });
    }
  });

  it("requires authentication and answers with the structured error body", async () => {
    const res = await callGet({});

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      message: expect.any(String),
      code: "authentication_failed",
    });
  });

  it("returns only the core field group by default (no comment/metadata/configId)", async () => {
    const { auth, projectId } = await newProject();
    const timestamp = new Date(Date.now() - 60_000);
    const id = randomUUID();

    await seedScore(projectId, {
      id,
      name: "core-score",
      dataType: "NUMERIC",
      value: 0.75,
      comment: "a comment",
      metadata: { nested: "yes" },
      traceId: randomUUID(),
      timestamp,
    });

    const res = await callGet({ query: { id }, auth });

    expect(res.status).toBe(200);
    const parsed = GetScoresResponseV3.parse(res.body);
    expect(parsed.meta).toEqual({ limit: 50 });
    expect(parsed.data).toHaveLength(1);
    const score = parsed.data[0];
    expect(score).toMatchObject({
      id,
      projectId,
      name: "core-score",
      dataType: "NUMERIC",
      value: 0.75,
      source: "API",
      environment: "default",
    });
    // upstream returns comment/configId/metadata only for fields=details
    expect(Object.keys(score).sort()).toEqual(
      [
        "createdAt",
        "dataType",
        "environment",
        "id",
        "name",
        "projectId",
        "source",
        "timestamp",
        "updatedAt",
        "value",
      ].sort(),
    );
  });

  it("adds the details, subject and annotation groups on request", async () => {
    const { auth, projectId } = await newProject();
    const timestamp = new Date(Date.now() - 60_000);
    const traceId = randomUUID();
    const observationId = randomUUID();
    const id = randomUUID();

    await seedScore(projectId, {
      id,
      name: "details-score",
      dataType: "NUMERIC",
      value: 1.5,
      comment: "a comment",
      metadata: { kind: "alignment" },
      traceId,
      observationId,
      authorUserId: "user-1",
      queueId: "queue-1",
      timestamp,
    });

    const res = await callGet({
      query: { id, fields: "core,details,subject,annotation" },
      auth,
    });

    expect(res.status).toBe(200);
    const score = GetScoresResponseV3.parse(res.body).data[0];
    expect(score).toMatchObject({
      comment: "a comment",
      configId: null,
      metadata: { kind: "alignment" },
      authorUserId: "user-1",
      queueId: "queue-1",
      subject: { kind: "observation", id: observationId, traceId },
    });
  });

  it("paginates with the upstream cursor scheme", async () => {
    const { auth, projectId } = await newProject();
    const traceId = randomUUID();
    const base = Date.now() - 120_000;
    const ids = Array.from({ length: 5 }, () => randomUUID());

    for (const [index, id] of ids.entries()) {
      await seedScore(projectId, {
        id,
        name: `page-score-${index}`,
        dataType: "NUMERIC",
        value: index,
        traceId,
        timestamp: new Date(base - index * 1000),
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    const pageCounts: number[] = [];
    for (let page = 0; page < 5; page++) {
      const res = await callGet({
        query: {
          limit: "2",
          traceId,
          ...(cursor ? { cursor } : {}),
        },
        auth,
      });
      expect(res.status).toBe(200);
      const parsed = GetScoresResponseV3.parse(res.body);
      pageCounts.push(parsed.data.length);
      seen.push(...parsed.data.map((score) => score.id));
      cursor = parsed.meta.cursor;
      if (!cursor) break;
    }

    expect(pageCounts).toEqual([2, 2, 1]);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // newest first, matching the ORDER BY timestamp DESC, id DESC contract
    expect(seen).toEqual(ids);
    expect(cursor).toBeUndefined();
  });

  it("filters by the v3 filter set and returns polymorphic values", async () => {
    const { auth, projectId } = await newProject();
    const traceId = randomUUID();
    const observationId = randomUUID();
    const base = Date.now() - 60_000;
    const scoreIds = {
      numeric: randomUUID(),
      boolean: randomUUID(),
      categorical: randomUUID(),
      text: randomUUID(),
      correction: randomUUID(),
      otherProject: randomUUID(),
    };

    await seedScore(projectId, {
      id: scoreIds.numeric,
      name: "filter-numeric",
      dataType: "NUMERIC",
      value: 3.5,
      traceId,
      environment: "prod",
      timestamp: new Date(base),
    });
    await seedScore(projectId, {
      id: scoreIds.boolean,
      name: "filter-boolean",
      dataType: "BOOLEAN",
      value: 1,
      stringValue: "True",
      traceId,
      environment: "prod",
      timestamp: new Date(base - 1000),
    });
    await seedScore(projectId, {
      id: scoreIds.categorical,
      name: "filter-categorical",
      dataType: "CATEGORICAL",
      value: 0,
      stringValue: "resolved",
      traceId,
      environment: "prod",
      timestamp: new Date(base - 2000),
    });
    await seedScore(projectId, {
      id: scoreIds.text,
      name: "filter-text",
      dataType: "TEXT",
      value: 0,
      stringValue: "some text",
      traceId,
      environment: "prod",
      timestamp: new Date(base - 3000),
    });
    await seedScore(projectId, {
      id: scoreIds.correction,
      name: "output",
      dataType: "CORRECTION",
      value: 0,
      longStringValue: "corrected output",
      traceId,
      environment: "prod",
      timestamp: new Date(base - 4000),
    });

    // rows of another project must never leak into the response
    const other = await newProject();
    await seedScore(other.projectId, {
      id: scoreIds.otherProject,
      name: "filter-numeric",
      dataType: "NUMERIC",
      value: 3.5,
      traceId,
      timestamp: new Date(base),
    });

    const byId = await callGet({
      query: {
        id: [
          scoreIds.numeric,
          scoreIds.boolean,
          scoreIds.categorical,
          scoreIds.text,
          scoreIds.correction,
        ].join(","),
        limit: "10",
      },
      auth,
    });
    expect(byId.status).toBe(200);
    const all = GetScoresResponseV3.parse(byId.body).data;
    expect(all).toHaveLength(5);
    expect(
      Object.fromEntries(all.map((score) => [score.dataType, score.value])),
    ).toEqual({
      NUMERIC: 3.5,
      BOOLEAN: true,
      CATEGORICAL: "resolved",
      TEXT: "some text",
      CORRECTION: "corrected output",
    });

    const cases: Array<{ query: Record<string, string>; expected: string[] }> =
      [
        { query: { traceId }, expected: Object.values(scoreIds).slice(0, 5) },
        {
          query: { id: scoreIds.numeric },
          expected: [scoreIds.numeric],
        },
        {
          query: { dataType: "NUMERIC", traceId },
          expected: [scoreIds.numeric],
        },
        {
          query: { source: "api", traceId },
          expected: Object.values(scoreIds).slice(0, 5),
        },
        {
          query: { value: "3.5", dataType: "NUMERIC", traceId },
          expected: [scoreIds.numeric],
        },
        {
          query: { value: "true", dataType: "BOOLEAN", traceId },
          expected: [scoreIds.boolean],
        },
        {
          query: { value: "false", dataType: "BOOLEAN", traceId },
          expected: [],
        },
        {
          query: { value: "resolved", dataType: "CATEGORICAL", traceId },
          expected: [scoreIds.categorical],
        },
        {
          query: { valueMin: "3", valueMax: "4", dataType: "NUMERIC", traceId },
          expected: [scoreIds.numeric],
        },
        {
          query: { environment: "prod", traceId },
          expected: Object.values(scoreIds).slice(0, 5),
        },
        {
          query: { environment: "dev", traceId },
          expected: [],
        },
        {
          query: { traceId, observationId },
          expected: [],
        },
        {
          query: { sessionId: randomUUID() },
          expected: [],
        },
      ];

    for (const { query, expected } of cases) {
      const res = await callGet({ query: { limit: "10", ...query }, auth });
      expect({ query, status: res.status }).toEqual({ query, status: 200 });
      expect({
        query,
        ids: GetScoresResponseV3.parse(res.body).data.map((score) => score.id),
      }).toEqual({ query, ids: expected });
    }
  });

  it("rejects the unsupported and malformed v3 query parameters with 400", async () => {
    const { auth } = await newProject();

    const cases: Array<{ query: Record<string, string>; code: string }> = [
      { query: { limit: "0" }, code: "invalid_query" },
      { query: { limit: "101" }, code: "invalid_query" },
      { query: { limit: "abc" }, code: "invalid_query" },
      { query: { unknown: "1" }, code: "invalid_query" },
      { query: { userId: "u" }, code: "invalid_query" },
      { query: { traceTags: "t" }, code: "invalid_query" },
      { query: { value: "1.5" }, code: "invalid_query" },
      { query: { valueMin: "1" }, code: "invalid_query" },
      {
        query: { value: "true", dataType: "BOOLEAN,CATEGORICAL" },
        code: "invalid_query",
      },
      { query: { observationId: randomUUID() }, code: "invalid_query" },
      {
        query: { traceId: randomUUID(), sessionId: randomUUID() },
        code: "invalid_query",
      },
      { query: { cursor: "not-a-cursor" }, code: "invalid_request" },
      { query: { fields: "nope" }, code: "invalid_query" },
    ];

    for (const { query, code } of cases) {
      const res = await callGet({ query, auth });
      expect({ query, status: res.status, code: res.body.code }).toEqual({
        query,
        status: 400,
        code,
      });
    }

    // the structured contract always carries a machine-readable code
    const res = await callGet({ query: { limit: "0" }, auth });
    expect(res.body).toMatchObject({
      message: "Invalid query parameters",
      code: "invalid_query",
      details: { issues: expect.any(Array) },
    });
  });

  it("treats empty query values as absent, like upstream", async () => {
    const { auth, projectId } = await newProject();
    const id = randomUUID();
    await seedScore(projectId, {
      id,
      name: "empty-params",
      dataType: "NUMERIC",
      value: 1,
      timestamp: new Date(Date.now() - 60_000),
    });

    const res = await callGet({
      query: {
        limit: "",
        fromTimestamp: "",
        toTimestamp: "",
        valueMin: "",
        id,
      },
      auth,
    });

    expect(res.status).toBe(200);
    const parsed = GetScoresResponseV3.parse(res.body);
    expect(parsed.meta.limit).toBe(50);
    expect(parsed.data.map((score) => score.id)).toEqual([id]);
  });
});
