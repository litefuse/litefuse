import { describe, it, expect, vi } from "vitest";

// OtelIngestionProcessor imports env (zod-validated at module load) — stub the
// only fields it reads so the class can be constructed in isolation.
vi.mock("../../../env", () => ({
  env: {
    LITEFUSE_S3_EVENT_UPLOAD_PREFIX: "",
    LITEFUSE_S3_EVENT_UPLOAD_BUCKET: "test-bucket",
  },
}));
vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { internalTraceEventsToResourceSpans } from "../internalTraceToResourceSpans";
import { LangfuseOtelSpanAttributes } from "../attributes";
import { OtelIngestionProcessor } from "../OtelIngestionProcessor";

// Classic events as emitted by CallbackHandler._exportLocalEvents.
const events = [
  {
    type: "trace-create",
    body: {
      id: "trace-1",
      name: "Execute evaluator: correctness",
      userId: "u-1",
      sessionId: "s-1",
      tags: ["eval"],
      metadata: { k: "v" },
      public: false,
    },
  },
  {
    type: "generation-create",
    body: {
      id: "gen-1",
      traceId: "trace-1",
      parentObservationId: undefined, // root
      name: "OpenAI",
      startTime: "2026-08-20T10:00:00.000Z",
      input: [{ role: "user", content: "hi" }],
      model: "gpt-4o",
    },
  },
  {
    type: "generation-update",
    body: {
      id: "gen-1",
      output: { role: "assistant", content: "hello" },
      endTime: "2026-08-20T10:00:01.000Z",
      usageDetails: { input: 10, output: 5, total: 15 },
    },
  },
  {
    type: "span-create",
    body: {
      id: "span-1",
      traceId: "trace-1",
      parentObservationId: "gen-1", // child
      name: "parse",
      startTime: "2026-08-20T10:00:00.500Z",
    },
  },
];

describe("internalTraceEventsToResourceSpans", () => {
  const rs = internalTraceEventsToResourceSpans(events, {
    environment: "langfuse-llm-judge",
  });
  const spans = rs[0]?.scopeSpans?.[0]?.spans ?? [];

  it("emits one span per merged observation, ids as verbatim strings", () => {
    expect(spans.length).toBe(2);
    const ids = spans.map((s: any) => s.spanId).sort();
    expect(ids).toEqual(["gen-1", "span-1"]);
    expect(spans.every((s: any) => s.traceId === "trace-1")).toBe(true);
  });

  it("merges create+update: root generation carries output + usage + endTime", () => {
    const gen: any = spans.find((s: any) => s.spanId === "gen-1");
    const attr = (k: string) =>
      gen.attributes.find((a: any) => a.key === k)?.value;
    expect(attr(LangfuseOtelSpanAttributes.AS_ROOT)?.boolValue).toBe(true);
    expect(
      attr(LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT)?.stringValue,
    ).toContain("hello");
    expect(
      attr(LangfuseOtelSpanAttributes.OBSERVATION_USAGE_DETAILS)?.stringValue,
    ).toContain("15");
    expect(
      attr(LangfuseOtelSpanAttributes.OBSERVATION_MODEL)?.stringValue,
    ).toBe("gpt-4o");
    expect(attr(LangfuseOtelSpanAttributes.TRACE_NAME)?.stringValue).toBe(
      "Execute evaluator: correctness",
    );
    expect(gen.endTimeUnixNano).toBeDefined();
  });

  it("child span keeps its parent, no AS_ROOT", () => {
    const child: any = spans.find((s: any) => s.spanId === "span-1");
    expect(child.parentSpanId).toBe("gen-1");
    expect(
      child.attributes.find(
        (a: any) => a.key === LangfuseOtelSpanAttributes.AS_ROOT,
      ),
    ).toBeUndefined();
  });

  it("round-trips through processToEvent: correct span/trace/parent ids", () => {
    const proc: any = new OtelIngestionProcessor({ projectId: "p1" });
    const out = proc.processToEvent(rs);
    const bySpan = new Map(out.map((e: any) => [e.spanId, e]));
    expect(bySpan.has("gen-1")).toBe(true);
    expect(bySpan.has("span-1")).toBe(true);
    const gen: any = bySpan.get("gen-1");
    expect(gen.traceId).toBe("trace-1");
    expect(gen.parentSpanId == null || gen.parentSpanId === "").toBe(true); // root
    // nano-string timestamp round-trips back to the original ISO
    expect(gen.startTimeISO).toBe("2026-08-20T10:00:00.000Z");
    expect(gen.endTimeISO).toBe("2026-08-20T10:00:01.000Z");
    // input/output survive the OTLP round-trip
    expect(JSON.stringify(gen.input)).toContain("hi");
    expect(JSON.stringify(gen.output)).toContain("hello");
    const child: any = bySpan.get("span-1");
    expect(child.parentSpanId).toBe("gen-1");
  });
});
