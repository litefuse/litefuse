import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getObservationBatchPreviews } from "@/src/features/observations/server/observationBatchPreviews";
import {
  observationBatchPreviewInput,
  observationPreviewKey,
  getObservationPreviewReferences,
} from "@/src/features/observations/lib/observationBatchPreview";
import { queryDoris, tableFor } from "@langfuse/shared/src/server";

jest.mock("@langfuse/shared", () =>
  jest.requireActual(
    "../../../../packages/shared/src/server/utils/metadata_conversion",
  ),
);
jest.mock("@langfuse/shared/src/server", () => ({
  queryDoris: jest.fn(),
  tableFor: jest.fn((projectId, table) => `${table}_${projectId}`),
  ...jest.requireActual(
    "../../../../packages/shared/src/server/repositories/analyticsDateTime",
  ),
  parseDorisUTCDateTimeFormat: (value: string) =>
    new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z"),
}));

const first = {
  id: "same-span",
  traceId: "trace-a",
  startTime: new Date("2026-10-13T01:02:03.123Z"),
};
const second = {
  ...first,
  traceId: "trace-b",
  startTime: new Date("2026-10-14T02:03:04.456Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(queryDoris).mockResolvedValue([]);
});

describe("observation list compact previews", () => {
  it("fetches one page batch instead of mounting a byId query per observation", () => {
    const source = readFileSync(
      join(__dirname, "../../components/table/use-cases/observations.tsx"),
      "utf8",
    );

    expect(source.includes("api.observations.byId.useQuery")).toBe(false);
    expect(
      source.match(/api\.observations\.batchPreviews\.useQuery/g),
    ).toHaveLength(1);
  });

  it("uses project authorization rather than the public-trace byId procedure", () => {
    const source = readFileSync(
      join(__dirname, "../../server/api/routers/observations.ts"),
      "utf8",
    );
    expect(source).toMatch(/batchPreviews:\s*protectedProjectProcedure/);
    expect(source).toMatch(
      /getObservationBatchPreviews\(\{[\s\S]*?projectId: ctx.session.projectId/,
    );
  });

  it("queries one split table for the whole page, matching exact tuples and time bounds without full IO", async () => {
    await getObservationBatchPreviews({
      projectId: "project_a",
      observations: [first, second, first],
      includeMetadata: true,
    });

    expect(tableFor).toHaveBeenCalledWith("project_a", "spans");
    expect(queryDoris).toHaveBeenCalledTimes(1);
    const { query, params } = jest.mocked(queryDoris).mock.calls[0][0];
    expect(query).toContain("FROM spans_project_a");
    expect(query).toContain("project_id = {projectId: String}");
    expect(query).toContain("start_time >= {minStartTime: DateTime64(3)}");
    expect(query).toContain("start_time <= {maxStartTime: DateTime64(3)}");
    for (const index of [0, 1]) {
      expect(query).toContain(
        `(trace_id = {traceId${index}: String} AND span_id = {id${index}: String} AND start_time = {startTime${index}: DateTime64(3)})`,
      );
    }
    expect(query).not.toContain("traceId2");
    expect(query).toContain("input_trim");
    expect(query).toContain("output_trim");
    expect(query).toContain("json_object_flatten(metadata)");
    expect(query).not.toMatch(/\b(input|output)\b/);
    expect(query).toMatch(
      /PARTITION BY trace_id, span_id, start_time\s+ORDER BY created_at DESC/,
    );
    expect(params).toMatchObject({
      projectId: "project_a",
      id0: first.id,
      traceId0: first.traceId,
      id1: second.id,
      traceId1: second.traceId,
      startTime0: "2026-10-13 01:02:03.123",
      startTime1: "2026-10-14 02:03:04.456",
      minStartTime: "2026-10-13 01:02:03.123",
      maxStartTime: "2026-10-14 02:03:04.456",
    });
  });

  it("preserves trims verbatim, missing previews as null, and decoded/stringified metadata", async () => {
    jest.mocked(queryDoris).mockResolvedValue([
      {
        id: first.id,
        trace_id: first.traceId,
        start_time: "2026-10-13 01:02:03.123",
        input_trim: '{"partial":',
        output_trim: "",
        metadata: JSON.stringify({
          "nested.key": "123",
          property: '{"ok":true}',
          text: "hello",
          nil: null,
        }),
      },
      {
        id: second.id,
        trace_id: second.traceId,
        start_time: "2026-10-14 02:03:04.456",
        input_trim: null,
        metadata: null,
      },
    ]);
    const previews = await getObservationBatchPreviews({
      projectId: "project_a",
      observations: [first, second],
      includeMetadata: true,
    });
    expect(previews).toEqual([
      {
        ...first,
        input: '{"partial":',
        output: "",
        metadata: JSON.stringify({
          "nested.key": 123,
          property: { ok: true },
          text: "hello",
          nil: null,
        }),
      },
      { ...second, input: null, output: null, metadata: "{}" },
    ]);
  });

  it("skips empty batches and rejects missing identity, invalid dates, or oversized requests", async () => {
    await expect(
      getObservationBatchPreviews({ projectId: "project_a", observations: [] }),
    ).resolves.toEqual([]);
    expect(queryDoris).not.toHaveBeenCalled();
    for (const observations of [
      [{ ...first, traceId: "" }],
      [{ ...first, id: "" }],
      [{ ...first, startTime: undefined }],
      [{ ...first, startTime: new Date("invalid") }],
      Array.from({ length: 1001 }, () => first),
    ]) {
      expect(
        observationBatchPreviewInput.safeParse({
          projectId: "project_a",
          observations,
        }).success,
      ).toBe(false);
    }
  });

  it("does not select or decode metadata when hidden (the default)", async () => {
    jest.mocked(queryDoris).mockResolvedValue([
      {
        id: first.id,
        trace_id: first.traceId,
        start_time: "2026-10-13 01:02:03.123",
        input_trim: "preview",
        output_trim: null,
      },
    ]);
    const result = await getObservationBatchPreviews({
      projectId: "project_a",
      observations: [first],
    });
    expect(jest.mocked(queryDoris).mock.calls[0][0].query).not.toContain(
      "metadata",
    );
    expect(result).toEqual([
      { ...first, input: "preview", output: null, metadata: undefined },
    ]);
    expect(
      observationBatchPreviewInput.parse({
        projectId: "project_a",
        observations: [first],
      }).includeMetadata,
    ).toBe(false);
  });

  it("keeps same span IDs in different traces/times distinct and skips rows without a trace", () => {
    const later = { ...first, startTime: second.startTime };
    expect(
      new Set([first, second, later].map(observationPreviewKey)).size,
    ).toBe(3);
    expect(
      getObservationPreviewReferences([
        first,
        second,
        first,
        later,
        { ...first, traceId: null },
      ]),
    ).toEqual([first, second, later]);
  });
});
