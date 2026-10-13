/**
 * GET /api/public/v2/observations must only read the Doris columns needed by
 * the requested field groups (`fields`). Reading every column (input/output,
 * input_trim/output_trim, metadata, usage maps, …) and dropping them in Node
 * made `fields=core,basic,time` cost the same as a full IO read.
 *
 * The equivalence suite proves the projection is a pure performance change:
 * for every field-group selection the response equals what the previous
 * select-everything query produced after the post-query field filter.
 */

import { describe, it, expect, vi } from "vitest";

const { queryDorisMock } = vi.hoisted(() => ({ queryDorisMock: vi.fn() }));
vi.mock("../doris", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../doris")>()),
  queryDoris: queryDorisMock,
}));

import {
  buildObservationsQueryDoris,
  getObservationsV2FromEventsTableForPublicApi,
  OBSERVATION_FIELD_GROUPS,
  type ObservationFieldGroup,
  type PublicApiObservationsQuery,
} from "../events";

const mockedQueryDoris = queryDorisMock;

// Table-name-safe project id so tableFor(projectId, "spans") is valid.
const projectId = "7a88fb47b4e243b8a06ca5ce950dc53a";

const baseOpts = {
  projectId,
  page: 0,
  limit: 50,
  traceId: "trace-1",
} satisfies PublicApiObservationsQuery;

/** Parse the result-column aliases out of the outer SELECT list. */
function selectedAliases(sql: string): string[] {
  const select = sql.slice(
    sql.indexOf("SELECT") + "SELECT".length,
    sql.indexOf("FROM"),
  );
  return select
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const asMatch = item.match(/\bAS\s+`?([A-Za-z_]+)`?\s*$/i);
      if (asMatch) return asMatch[1];
      return item.replace(/^o\./, "").replace(/`/g, "");
    });
}

/** A row shaped like the mysql2 result of the previous full SELECT. */
const fullRow = (): Record<string, unknown> => ({
  id: "obs-1",
  type: "GENERATION",
  project_id: projectId,
  name: "llm-call",
  start_time: new Date("2026-08-19T01:38:45.902Z"),
  end_time: new Date("2026-08-19T01:38:47.402Z"),
  trace_id: "trace-1",
  parent_observation_id: "parent-1",
  environment: "default",
  level: "DEFAULT",
  status_message: "ok",
  version: "v1",
  input: '{"messages":[{"role":"user","content":"hi"}]}',
  output: '{"role":"assistant","content":"hello"}',
  input_trim: '{"messages":[{"role":"us',
  output_trim: '{"role":"assist',
  metadata: '{"key":"value","nested.k":"v2"}',
  prompt_id: "prompt-1",
  prompt_name: "my-prompt",
  prompt_version: 3,
  // null keeps the model enrichment from querying Postgres.
  internal_model_id: null,
  provided_model_name: "gpt-4o",
  usage_details: '{"input":10,"output":5,"total":15}',
  cost_details: '{"input":0.001,"output":0.002,"total":0.003}',
  total_cost: "0.003000000000",
  usage_pricing_tier_name: "Standard",
  completion_start_time: new Date("2026-08-19T01:38:46.402Z"),
  created_at: new Date("2026-08-19T01:38:48.000Z"),
  trace_name: "trace-name",
  tags: ["prod", "sdk-js"],
  release: "2026.08.19",
  bookmarked: 1,
  public: 0,
  user_id: "user-1",
  session_id: "session-1",
});

/** Simulates Doris: returns only the columns the SQL actually selects. */
function respondWithSelectedColumns() {
  mockedQueryDoris.mockImplementation(async (opts: { query: string }) => {
    const aliases = new Set(selectedAliases(opts.query));
    const row = fullRow();
    return [
      Object.fromEntries(
        Object.entries(row).filter(([key]) => aliases.has(key)),
      ),
    ];
  });
}

/** Simulates the previous behavior: every column regardless of `fields`. */
function respondWithAllColumns() {
  mockedQueryDoris.mockImplementation(async () => [fullRow()]);
}

const HEAVY_COLUMNS = [
  "input",
  "output",
  "input_trim",
  "output_trim",
  "metadata",
  "usage_details",
  "cost_details",
];

describe("buildObservationsQueryDoris — field-group projection", () => {
  it("selects only core/basic/time columns for fields=core,basic,time", () => {
    const { baseQuery } = buildObservationsQueryDoris(baseOpts, {
      fields: ["core", "basic", "time"],
    });
    const aliases = selectedAliases(baseQuery);

    expect(aliases.sort()).toEqual(
      [
        "id",
        "trace_id",
        "start_time",
        "end_time",
        "project_id",
        "parent_observation_id",
        "type",
        "name",
        "level",
        "status_message",
        "version",
        "environment",
        "bookmarked",
        "public",
        "user_id",
        "session_id",
        "completion_start_time",
        "created_at",
      ].sort(),
    );
    for (const heavy of HEAVY_COLUMNS) expect(aliases).not.toContain(heavy);
  });

  it("adds only input/output (not trims or metadata) when io is requested", () => {
    const { baseQuery } = buildObservationsQueryDoris(baseOpts, {
      fields: ["core", "basic", "time", "io"],
    });
    const aliases = selectedAliases(baseQuery);

    expect(aliases).toContain("input");
    expect(aliases).toContain("output");
    expect(aliases).not.toContain("input_trim");
    expect(aliases).not.toContain("output_trim");
    expect(aliases).not.toContain("metadata");
    expect(baseQuery).not.toContain("json_object_flatten");
  });

  it("always selects core columns even when only another group is requested", () => {
    const { baseQuery } = buildObservationsQueryDoris(baseOpts, {
      fields: ["prompt"],
    });
    const aliases = selectedAliases(baseQuery);

    for (const core of [
      "id",
      "trace_id",
      "start_time",
      "end_time",
      "project_id",
      "parent_observation_id",
      "type",
    ]) {
      expect(aliases).toContain(core);
    }
    expect(aliases).toEqual(
      expect.arrayContaining(["prompt_id", "prompt_name", "prompt_version"]),
    );
  });

  it("keeps every column for the V1 path (no projection)", () => {
    const { baseQuery } = buildObservationsQueryDoris(baseOpts);
    const aliases = selectedAliases(baseQuery);

    for (const heavy of HEAVY_COLUMNS) expect(aliases).toContain(heavy);
  });

  it("sends the projected SELECT to Doris from the V2 repository", async () => {
    respondWithSelectedColumns();
    await getObservationsV2FromEventsTableForPublicApi({
      ...baseOpts,
      fields: ["core", "basic", "time"],
    });

    const sql = mockedQueryDoris.mock.calls.at(-1)?.[0].query ?? "";
    const aliases = selectedAliases(sql);
    for (const heavy of HEAVY_COLUMNS) expect(aliases).not.toContain(heavy);
    expect(sql).toContain("LIMIT 51");
  });
});

describe("getObservationsV2FromEventsTableForPublicApi — response equivalence", () => {
  const selections: ObservationFieldGroup[][] = [
    [],
    [...OBSERVATION_FIELD_GROUPS],
    ["core"],
    ["core", "basic"],
    ["core", "basic", "time"],
    ["core", "basic", "time", "io"],
    // metrics derives timeToFirstToken from completion_start_time, which
    // belongs to the time group — it must still be correct on its own.
    ["metrics"],
    ...OBSERVATION_FIELD_GROUPS.filter((g) => g !== "core").map((g) => [
      "core" as const,
      g,
    ]),
  ];

  it.each(selections.map((fields) => [fields.join(",") || "(empty)", fields]))(
    "fields=%s returns the same observations as the full-column query",
    async (_label, fields) => {
      respondWithAllColumns();
      const expected = await getObservationsV2FromEventsTableForPublicApi({
        ...baseOpts,
        fields: fields as ObservationFieldGroup[],
      });

      respondWithSelectedColumns();
      const actual = await getObservationsV2FromEventsTableForPublicApi({
        ...baseOpts,
        fields: fields as ObservationFieldGroup[],
      });

      expect(actual).toEqual(expected);
      expect(actual).toHaveLength(1);
    },
  );
});
