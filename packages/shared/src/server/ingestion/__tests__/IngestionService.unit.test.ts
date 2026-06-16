import { expect, describe, it, vi } from "vitest";
import { IngestionService } from "../IngestionService";
import { convertDateToAnalyticsDateTime } from "@langfuse/shared/src/server";
import { eventTypes } from "../types";
import { TableName } from "../ingestionWriter";

describe("IngestionService unit tests", () => {
  it("correctly sorts events in ascending order by timestamp", async () => {
    const firstTrace = { timestamp: 1, type: "observation-create" };
    const secondTrace = { timestamp: 1, type: "observation-update" };
    const thirdTrace = { timestamp: 3, type: "observation-update" };

    const records = [thirdTrace, secondTrace, firstTrace];

    const sortedEventList = (IngestionService as any).toTimeSortedEventList(
      records,
    );

    expect(sortedEventList).toEqual([firstTrace, secondTrace, thirdTrace]);
    expect(sortedEventList).not.toBe(records);
  });

  it("correctly convert Date to Doris DateTime", async () => {
    const date = new Date("2024-10-12T12:13:14.123Z");

    const analyticsDateTime = convertDateToAnalyticsDateTime(date);

    expect(analyticsDateTime).toEqual("2024-10-12 12:13:14.123");
  });

  it("stores full generation input in mergeAndWrite", async () => {
    const addToQueue = vi.fn();
    const service = new IngestionService(
      {} as any,
      { addToQueue } as any,
      null,
      null,
      null,
    );

    vi.spyOn(service as any, "getPrompt").mockResolvedValue(null);
    vi.spyOn(service as any, "mapObservationEventsToRecords").mockReturnValue([
      {
        id: "obs-1",
        trace_id: "trace-1",
        project_id: "project-1",
        type: "GENERATION",
        parent_observation_id: null,
        environment: "default",
        name: "gen",
        metadata: {},
        level: "DEFAULT",
        status_message: null,
        version: null,
        input: null,
        output: null,
        provided_model_name: null,
        internal_model_id: null,
        model_parameters: null,
        total_cost: null,
        usage_pricing_tier_id: null,
        usage_pricing_tier_name: null,
        prompt_id: null,
        prompt_name: null,
        prompt_version: null,
        tool_definitions: {},
        tool_calls: [],
        tool_call_names: [],
        is_deleted: 0,
        created_at: 0,
        updated_at: 0,
        start_time: Date.parse("2026-05-25T08:30:00.000Z"),
        end_time: null,
        completion_start_time: null,
        event_ts: Date.parse("2026-05-28T00:00:00.000Z"),
        provided_usage_details: {},
        provided_cost_details: {},
        usage_details: {},
        cost_details: {},
      },
    ]);
    vi.spyOn(service as any, "mergeObservationRecords").mockResolvedValue({
      id: "obs-1",
      trace_id: "trace-1",
      project_id: "project-1",
      type: "GENERATION",
      parent_observation_id: null,
      environment: "default",
      name: "gen",
      metadata: {},
      level: "DEFAULT",
      status_message: null,
      version: null,
      input: null,
      output: null,
      provided_model_name: null,
      internal_model_id: null,
      model_parameters: null,
      total_cost: null,
      usage_pricing_tier_id: null,
      usage_pricing_tier_name: null,
      prompt_id: null,
      prompt_name: null,
      prompt_version: null,
      tool_definitions: {},
      tool_calls: [],
      tool_call_names: [],
      is_deleted: 0,
      created_at: 0,
      updated_at: 0,
      start_time: Date.parse("2026-05-25T08:30:00.000Z"),
      end_time: null,
      completion_start_time: null,
      event_ts: Date.parse("2026-05-28T00:00:00.000Z"),
      provided_usage_details: {},
      provided_cost_details: {},
      usage_details: {},
      cost_details: {},
    });
    vi.spyOn(service as any, "stringify").mockImplementation((value) =>
      JSON.stringify(value),
    );

    const event = {
      id: "evt-1",
      type: eventTypes.GENERATION_CREATE,
      timestamp: "2026-05-28T01:02:03.000Z",
      body: {
        id: "obs-1",
        traceId: "trace-1",
        name: "gen",
        startTime: "2026-05-25T08:30:00.000Z",
        input: [{ role: "user", content: "hello" }],
      },
      metadata: {},
    } as any;

    await (service as any).processObservationEventList({
      projectId: "project-1",
      entityId: "obs-1",
      createdAtTimestamp: new Date("2026-05-28T09:00:00.000Z"),
      observationEventList: [event],
    });

    const eventsFullWrites = addToQueue.mock.calls.filter(
      ([tableName]) => tableName === TableName.EventsFull,
    );
    expect(eventsFullWrites).toHaveLength(1);
    expect(eventsFullWrites[0][1].input).toBe(
      JSON.stringify([{ role: "user", content: "hello" }]),
    );
  });

  it("stores full generation input in direct event records", async () => {
    const addToQueue = vi.fn();
    const service = new IngestionService(
      {} as any,
      { addToQueue } as any,
      null,
      null,
      null,
    );

    const input = JSON.stringify([{ role: "user", content: "hello" }]);
    const eventRecord = await service.createEventRecord(
      {
        projectId: "project-1",
        traceId: "trace-1",
        spanId: "span-1",
        startTimeISO: "2026-05-25T08:30:00.000Z",
        endTimeISO: "2026-05-25T08:31:00.000Z",
        type: "GENERATION",
        name: "gen",
        input,
        metadata: {},
        source: "otel",
      },
      "",
    );

    expect(addToQueue).not.toHaveBeenCalled();
    expect(eventRecord.input).toBe(input);
  });

  it("direct-writes native generations as root observations without t-trace parents", async () => {
    const addToQueue = vi.fn();
    const service = new IngestionService(
      { $executeRaw: vi.fn() } as any,
      { addToQueue } as any,
      null,
      null,
      null,
    );

    await service.directWriteTraceObservationEvents({
      projectId: "project-1",
      createdAtTimestamp: new Date("2026-06-10T09:00:00.000Z"),
      source: "api",
      events: [
        {
          id: "evt-trace",
          type: eventTypes.TRACE_CREATE,
          timestamp: "2026-06-10T08:59:59.000Z",
          body: {
            id: "trace-1",
            name: "trace-name",
            timestamp: "2026-06-10T08:59:59.000Z",
            environment: "default",
          },
        },
        {
          id: "evt-gen",
          type: eventTypes.GENERATION_CREATE,
          timestamp: "2026-06-10T09:00:00.000Z",
          body: {
            id: "gen-1",
            traceId: "trace-1",
            name: "gen",
            startTime: "2026-06-10T09:00:00.000Z",
            input: { prompt: "hello" },
            environment: "default",
          },
        },
      ] as any,
    });

    const eventsFullWrites = addToQueue.mock.calls.filter(
      ([tableName]) => tableName === TableName.EventsFull,
    );

    expect(eventsFullWrites).toHaveLength(1);
    expect(eventsFullWrites[0][1]).toMatchObject({
      trace_id: "trace-1",
      span_id: "gen-1",
      parent_span_id: "",
      trace_name: "trace-name",
    });
  });

  it("materializes a root observation row for trace-only writes", async () => {
    const addToQueue = vi.fn();
    const executeRaw = vi.fn();
    const service = new IngestionService(
      { $executeRaw: executeRaw } as any,
      { addToQueue } as any,
      null,
      null,
      null,
    );

    await service.directWriteTraceObservationEvents({
      projectId: "project-1",
      createdAtTimestamp: new Date("2026-06-10T09:00:00.000Z"),
      source: "api",
      events: [
        {
          id: "evt-trace",
          type: eventTypes.TRACE_CREATE,
          timestamp: "2026-06-10T08:59:59.000Z",
          body: {
            id: "trace-1",
            name: "trace-name",
            timestamp: "2026-06-10T08:59:59.000Z",
            environment: "default",
            sessionId: "session-1",
          },
        },
      ] as any,
    });

    const eventsFullWrites = addToQueue.mock.calls.filter(
      ([tableName]) => tableName === TableName.EventsFull,
    );

    expect(eventsFullWrites).toHaveLength(1);
    expect(eventsFullWrites[0][1]).toMatchObject({
      trace_id: "trace-1",
      span_id: "trace-1",
      parent_span_id: "",
      trace_name: "trace-name",
      session_id: "session-1",
    });
    expect(executeRaw).toHaveBeenCalled();
  });
});
