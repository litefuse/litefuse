import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryDorisStreamMock } = vi.hoisted(() => ({
  queryDorisStreamMock: vi.fn(),
}));

vi.mock("@langfuse/shared/src/server", async () => {
  const actual = await vi.importActual<object>("@langfuse/shared/src/server");
  return {
    ...actual,
    queryDorisStream: queryDorisStreamMock,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

import {
  getEventsStreamForDataset,
  getEventsStreamForEval,
} from "@/src/server/background/features/database-read-stream/event-stream";

const collectRows = async (stream: AsyncIterable<unknown>) => {
  const rows: unknown[] = [];
  for await (const row of stream) {
    rows.push(row);
  }
  return rows;
};

describe("background event streams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryDorisStreamMock.mockReset();
  });

  it("reads historic eval rows from events_full, reconstructs metadata, and normalizes null arrays", async () => {
    const captured: { query?: string } = {};

    queryDorisStreamMock.mockImplementation(({ query }: { query: string }) => {
      captured.query = query;

      return (async function* () {
        yield {
          span_id: "obs-1",
          trace_id: "trace-1",
          project_id: "project-1",
          start_time: new Date("2026-06-23T01:02:03.000Z"),
          parent_span_id: "parent-1",
          type: "GENERATION",
          name: "chat",
          environment: "default",
          version: "v1",
          level: "DEFAULT",
          status_message: null,
          trace_name: "trace-name",
          user_id: "user-1",
          session_id: "session-1",
          tags: ["tag-1"],
          release: "rel-1",
          provided_model_name: "gpt-4",
          model_parameters: { temperature: 0 },
          prompt_id: "prompt-1",
          prompt_name: "Prompt",
          prompt_version: 1,
          provided_usage_details: { input: 12 },
          usage_details: { output: 34 },
          provided_cost_details: { input: 0.12 },
          cost_details: { output: 0.34 },
          tool_definitions: { search: "{}" },
          tool_calls: null,
          tool_call_names: null,
          experiment_id: null,
          experiment_name: null,
          experiment_description: null,
          experiment_dataset_id: null,
          experiment_item_id: null,
          experiment_item_expected_output: null,
          experiment_item_root_span_id: null,
          input: { question: "hi" },
          output: { answer: "hello" },
          metadata_names: ["foo", "json"],
          metadata_values: ["bar", '{"nested":"value"}'],
        };
      })();
    });

    const stream = await getEventsStreamForEval({
      projectId: "project-1",
      cutoffCreatedAt: new Date("2026-06-24T00:00:00.000Z"),
      filter: [
        {
          column: "environment",
          operator: "any of",
          value: ["default"],
          type: "stringOptions",
        },
      ],
      rowLimit: 10,
    });

    const rows = await collectRows(stream);

    expect(captured.query).toContain("FROM events_full o");
    expect(captured.query).toContain("o.start_time");
    expect(captured.query).toContain("o.metadata_names");
    expect(captured.query).not.toContain("FROM events e");
    expect(rows).toEqual([
      expect.objectContaining({
        span_id: "obs-1",
        parent_span_id: "parent-1",
        start_time: new Date("2026-06-23T01:02:03.000Z"),
        tool_calls: [],
        tool_call_names: [],
        metadata: {
          foo: "bar",
          json: '{"nested":"value"}',
        },
      }),
    ]);
  });

  it("reads add-to-dataset rows from events_full and reconstructs metadata", async () => {
    const captured: { query?: string } = {};

    queryDorisStreamMock.mockImplementation(({ query }: { query: string }) => {
      captured.query = query;

      return (async function* () {
        yield {
          id: "obs-2",
          trace_id: "trace-2",
          input: { prompt: "q" },
          output: { completion: "a" },
          metadata_names: ["key"],
          metadata_values: ["value"],
        };
      })();
    });

    const stream = await getEventsStreamForDataset({
      projectId: "project-1",
      cutoffCreatedAt: new Date("2026-06-24T00:00:00.000Z"),
      filter: [],
      rowLimit: 10,
    });

    const rows = await collectRows(stream);

    expect(captured.query).toContain("FROM events_full o");
    expect(captured.query).toContain("o.metadata_names");
    expect(captured.query).not.toContain("FROM events e");
    expect(rows).toEqual([
      {
        id: "obs-2",
        traceId: "trace-2",
        input: { prompt: "q" },
        output: { completion: "a" },
        metadata: {
          key: "value",
        },
      },
    ]);
  });
});
