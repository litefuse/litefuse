import { getTracePreviews } from "@/src/features/traces/server/tracePreviewService";
import { queryDoris, tableFor } from "@langfuse/shared/src/server";

jest.mock("@langfuse/shared/src/server", () => ({
  queryDoris: jest.fn(),
  tableFor: jest.fn((_project, table) => `routed_${table}`),
  convertDateToAnalyticsDateTime: (value: Date) => value.toISOString(),
}));
jest.mock("@langfuse/shared", () => ({
  parseMetadataCHRecordToDomain: jest.requireActual(
    "../../../../packages/shared/src/server/utils/metadata_conversion",
  ).parseMetadataCHRecordToDomain,
}));

const query = jest.mocked(queryDoris);
const timestamp = new Date("2026-08-01T23:59:59.900Z");
const traces = Array.from({ length: 50 }, (_, index) => ({
  id: `trace-${index}`,
  timestamp,
}));

describe("Trace page previews", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockReset();
  });

  it("keeps the same ID on different days distinct and falls back for only the missing day", async () => {
    query.mockResolvedValueOnce([
      { id: "same", preview_day: "2026-08-01", input_trim: "first" },
    ]);
    query.mockResolvedValueOnce([
      { id: "same", preview_day: "2026-08-02", input_trim: "second" },
    ]);
    const result = await getTracePreviews({
      projectId: "p",
      includeMetadata: false,
      traces: [
        { id: "same", timestamp },
        { id: "same", timestamp: new Date("2026-08-02T00:01:00Z") },
      ],
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.map((row) => row.input)).toEqual(["first", "second"]);
    expect(query.mock.calls[1]![0].query).toContain(
      "PARTITION BY trace_id, DATE(start_time)",
    );
    expect(query.mock.calls[1]![0].params).toMatchObject({
      id0: "same",
      day0: "2026-08-02",
    });
  });

  it("fetches 50 previews in one project-scoped compact query, preserving metadata", async () => {
    query.mockResolvedValueOnce(
      traces.map(({ id }) => ({
        id,
        preview_day: "2026-08-01",
        input_trim: "preview input",
        output_trim: "preview output",
        metadata: { "nested.number": "123", flag: "true", text: '"hello"' },
      })),
    );
    const result = await getTracePreviews({
      projectId: "project-a",
      traces,
      includeMetadata: true,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(tableFor).toHaveBeenCalledWith("project-a", "traces_scalar");
    const request = query.mock.calls[0]![0];
    expect(request.query).toContain("project_id = {projectId: String}");
    expect(request.query).toContain("input_trim");
    expect(request.query).not.toMatch(/CAST\(input|CAST\(output/);
    expect(request.params?.projectId).toBe("project-a");
    expect(result).toHaveLength(50);
    expect(result[0]).toEqual({
      id: "trace-0",
      day: "2026-08-01",
      input: "preview input",
      output: "preview output",
      metadata: '{"nested.number":123,"flag":true,"text":"hello"}',
    });
  });

  it("does no work for an empty page", async () => {
    expect(
      await getTracePreviews({
        projectId: "p",
        traces: [],
        includeMetadata: false,
      }),
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("omits metadata reads when hidden and falls back once for missing scalar rows", async () => {
    query.mockResolvedValueOnce([
      {
        id: "trace-0",
        preview_day: "2026-08-01",
        input_trim: "",
        output_trim: null,
      },
    ]);
    query.mockResolvedValueOnce([
      {
        id: "trace-1",
        preview_day: "2026-08-01",
        input_trim: "fallback",
        output_trim: "ok",
      },
    ]);
    const result = await getTracePreviews({
      projectId: "p",
      traces: traces.slice(0, 3),
      includeMetadata: false,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0].query).not.toContain("json_object_flatten");
    const fallback = query.mock.calls[1]![0];
    expect(fallback.query).toContain("is_root = 1");
    expect(fallback.query).toContain("ROW_NUMBER()");
    expect(fallback.query).toContain("project_id = {projectId: String}");
    expect(result).toEqual([
      {
        id: "trace-0",
        day: "2026-08-01",
        input: "",
        output: null,
        metadata: undefined,
      },
      {
        id: "trace-1",
        day: "2026-08-01",
        input: "fallback",
        output: "ok",
        metadata: undefined,
      },
    ]);
  });

  it("uses half-open UTC day bounds covering both sides of midnight", async () => {
    query.mockResolvedValueOnce([
      { id: "a", preview_day: "2026-08-01" },
      { id: "b", preview_day: "2026-08-02" },
    ]);
    await getTracePreviews({
      projectId: "p",
      includeMetadata: false,
      traces: [
        { id: "a", timestamp },
        { id: "b", timestamp: new Date("2026-08-02T00:00:00.100Z") },
      ],
    });
    expect(query.mock.calls[0]![0].params).toMatchObject({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-03T00:00:00.000Z",
    });
  });
});
