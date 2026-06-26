/** @jest-environment node */

import {
  convertEventsObservation,
  createEvent,
} from "@langfuse/shared/src/server";

describe("convertEventsObservation", () => {
  it("preserves trace context fields on partial v2 conversions", () => {
    const writeRecord = createEvent({
      project_id: "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a",
      trace_id: "trace-v2-context",
      span_id: "span-v2-context",
      id: "span-v2-context",
      trace_name: "checkout-trace",
      release: "2026.05.15",
      tags: ["prod", "checkout"],
      user_id: "user-123",
      session_id: "session-123",
      parent_span_id: "",
      usage_pricing_tier_name: "Standard",
    });

    const timestamp = "2026-05-15 10:00:00.000000";
    const record = {
      ...writeRecord,
      start_time: timestamp,
      end_time: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      event_ts: timestamp,
      completion_start_time: timestamp,
    };

    const observation = convertEventsObservation(
      {
        ...record,
        parent_observation_id: record.parent_span_id,
      },
      {
        truncated: false,
        shouldJsonParse: false,
      },
      false,
    );

    expect(observation.traceName).toBe("checkout-trace");
    expect(observation.release).toBe("2026.05.15");
    expect(observation.tags).toEqual(["prod", "checkout"]);
    expect(observation.userId).toBe("user-123");
    expect(observation.sessionId).toBe("session-123");
  });

  it("parses Doris string maps, normalizes numeric booleans, and preserves raw io strings in v2", () => {
    const writeRecord = createEvent({
      project_id: "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a",
      trace_id: "trace-v2-usage",
      span_id: "span-v2-usage",
      id: "span-v2-usage",
      parent_span_id: "",
      input: JSON.stringify([
        {
          role: "user",
          content: "What is the capital of France?",
        },
      ]),
      output: JSON.stringify([
        {
          role: "assistant",
          content: "Paris",
        },
      ]),
    });

    const timestamp = "2026-05-15 10:00:00.000000";
    const observation = convertEventsObservation(
      {
        ...writeRecord,
        start_time: timestamp,
        end_time: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
        event_ts: timestamp,
        completion_start_time: timestamp,
        usage_details: '{"input":100,"output":50,"total":150}' as any,
        cost_details: '{"input":0.1,"output":0.2,"total":0.3}' as any,
        bookmarked: 0 as any,
        public: 1 as any,
        parent_observation_id: writeRecord.parent_span_id,
      },
      {
        truncated: false,
        shouldJsonParse: false,
      },
      false,
    );

    expect(observation.input).toBe(
      '[{"role":"user","content":"What is the capital of France?"}]',
    );
    expect(observation.output).toBe('[{"role":"assistant","content":"Paris"}]');
    expect(observation.usageDetails).toEqual({
      input: 100,
      output: 50,
      total: 150,
    });
    expect(observation.inputUsage).toBe(100);
    expect(observation.outputUsage).toBe(50);
    expect(observation.totalUsage).toBe(150);
    expect(observation.costDetails).toEqual({
      input: 0.1,
      output: 0.2,
      total: 0.3,
    });
    expect(observation.bookmarked).toBe(false);
    expect(observation.public).toBe(true);
  });
});
