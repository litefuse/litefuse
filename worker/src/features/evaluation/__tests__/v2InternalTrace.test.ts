import { describe, expect, it } from "vitest";
import {
  internalTraceEventsToResourceSpans,
  LangfuseInternalTraceEnvironment,
} from "@langfuse/shared/src/server";
import {
  buildDecisionModelTraceEvents,
  buildExecutionFailureTraceEvents,
  describeExecutionFailure,
} from "../v2InternalTrace";

/**
 * The decision model does not run through `fetchLLMCompletion`, so its execution
 * trace is built here by hand. These tests pin the two things that matter:
 * the record carries the request/answers, and it converts into the same OTLP
 * shape the internal-tracing pipeline expects (so it shows up as a normal trace).
 */
const params = {
  projectId: "project-1",
  executionTraceId: "trace-exec-1",
  traceName: "Execute evaluator: Harmfulness",
  traceStartTime: new Date("2026-01-01T00:00:00.000Z"),
  traceEndTime: new Date("2026-01-01T00:00:02.000Z"),
  request: {
    model: "jemma",
    state: { output: "hello" },
    questions: [],
  } as unknown as Parameters<typeof buildDecisionModelTraceEvents>[0]["request"],
  evaluation: {
    model: "jemma",
    answers: { q1: { type: "boolean", probability: 0.9 } },
    usage: { inputTokens: 120, outputTokens: 8 },
  } as unknown as Parameters<
    typeof buildDecisionModelTraceEvents
  >[0]["evaluation"],
  metadata: { evaluator_id: "evaluator-1", job_execution_id: "job-1" },
};

describe("buildDecisionModelTraceEvents", () => {
  it("builds a trace event plus one generation carrying request and answers", () => {
    const events = buildDecisionModelTraceEvents(params);

    expect(events.map((e) => e.type)).toEqual([
      "trace-create",
      "generation-create",
    ]);

    const [traceEvent, generationEvent] = events;
    expect(traceEvent?.body).toMatchObject({
      id: "trace-exec-1",
      name: "Execute evaluator: Harmfulness",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(generationEvent?.body).toMatchObject({
      id: "trace-exec-1",
      traceId: "trace-exec-1",
      model: "jemma",
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-01T00:00:02.000Z",
      usageDetails: { input: 120, output: 8 },
    });
    // The request is the input, the answers are the output.
    expect(generationEvent?.body.input).toContain("jemma");
    expect(generationEvent?.body.output).toContain("probability");
  });

  it("omits usage details when the provider reports none", () => {
    const events = buildDecisionModelTraceEvents({
      ...params,
      evaluation: {
        model: "jemma",
        answers: {},
        usage: null,
      } as unknown as typeof params.evaluation,
    });

    expect(events[1]?.body).not.toHaveProperty("usageDetails");
  });
});

describe("decision-model trace through the internal-tracing pipeline", () => {
  it("converts into one resource span with the environment attribute", () => {
    const events = buildDecisionModelTraceEvents(params);
    const resourceSpans = internalTraceEventsToResourceSpans(events, {
      environment: LangfuseInternalTraceEnvironment.LLMJudge,
    });

    expect(resourceSpans).toHaveLength(1);
    const spans = resourceSpans[0]?.scopeSpans?.[0]?.spans ?? [];
    expect(spans).toHaveLength(1);

    const span = spans[0]!;
    expect(span.traceId).toBe("trace-exec-1");
    expect(span.spanId).toBe("trace-exec-1");
    expect(span.name).toBe("Execute evaluator: Harmfulness");

    const attributeKeys = (span.attributes ?? [])
      .filter((attribute: { value: { stringValue?: string } }) =>
        Boolean(attribute.value?.stringValue),
      )
      .map((attribute: { key: string }) => attribute.key);
    // The reserved judge environment is what keeps this trace from being
    // evaluated again (isEvalTargetEnvironmentAllowed blocks it).
    expect(attributeKeys).toContain("langfuse.environment");
    expect(attributeKeys).toContain("langfuse.observation.input");
    expect(attributeKeys).toContain("langfuse.observation.output");
    expect(attributeKeys).toContain("langfuse.trace.name");
  });
});

/**
 * The evaluator's "Last 5 runs" column is derived from these traces, so a failed
 * execution has to leave one carrying `level=ERROR` and a readable reason — both
 * for the red marker and for the reader's `failed` flag
 * (`getRecentEvaluatorExecutionTraces`).
 */
const failureParams = {
  executionTraceId: "trace-exec-failed",
  traceName: "Execute evaluator: Harmfulness",
  traceStartTime: new Date("2026-01-01T00:00:00.000Z"),
  traceEndTime: new Date("2026-01-01T00:00:04.500Z"),
  metadata: {
    evaluator_id: "evaluator-1",
    evaluation_rule_id: "rule-1",
    evaluation_rule_assignment_id: "assignment-1",
    job_execution_id: "job-1",
    evaluator_version_id: "version-1",
  },
  statusMessage: "The connection rejected the request",
};

describe("buildExecutionFailureTraceEvents", () => {
  it("builds a trace event plus one ERROR span carrying the reason", () => {
    const events = buildExecutionFailureTraceEvents(failureParams);

    expect(events.map((e) => e.type)).toEqual(["trace-create", "span-create"]);

    const [traceEvent, spanEvent] = events;
    expect(traceEvent?.body).toMatchObject({
      id: "trace-exec-failed",
      name: "Execute evaluator: Harmfulness",
      timestamp: "2026-01-01T00:00:00.000Z",
      metadata: failureParams.metadata,
    });
    expect(spanEvent?.body).toMatchObject({
      id: "trace-exec-failed",
      traceId: "trace-exec-failed",
      level: "ERROR",
      statusMessage: "The connection rejected the request",
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-01T00:00:04.500Z",
      metadata: failureParams.metadata,
    });
  });

  it("converts into a root span whose level and status message survive", () => {
    const resourceSpans = internalTraceEventsToResourceSpans(
      buildExecutionFailureTraceEvents(failureParams),
      { environment: LangfuseInternalTraceEnvironment.LLMJudge },
    );

    const span = resourceSpans[0]?.scopeSpans?.[0]?.spans?.[0];
    expect(span?.spanId).toBe("trace-exec-failed");

    const attributes = new Map(
      (span?.attributes ?? []).map(
        (attribute: { key: string; value: { stringValue?: string } }) => [
          attribute.key,
          attribute.value?.stringValue,
        ],
      ),
    );
    expect(attributes.get("langfuse.observation.type")).toBe("span");
    expect(attributes.get("langfuse.observation.level")).toBe("ERROR");
    expect(attributes.get("langfuse.observation.status_message")).toBe(
      "The connection rejected the request",
    );
    expect(attributes.get("langfuse.environment")).toBe(
      LangfuseInternalTraceEnvironment.LLMJudge,
    );
    // The evaluator id is what the execution history is grouped by.
    expect(attributes.get("langfuse.trace.metadata")).toContain("evaluator-1");
  });
});

describe("describeExecutionFailure", () => {
  it("uses the error message", () => {
    expect(describeExecutionFailure(new Error("boom"))).toBe("boom");
  });

  it("falls back for values that carry no message", () => {
    expect(describeExecutionFailure("")).toBe("Unknown evaluation error");
    expect(describeExecutionFailure({ code: 402 })).toContain("402");
  });

  it("truncates a pathologically long reason", () => {
    const message = describeExecutionFailure(new Error("x".repeat(5_000)));
    expect(message.length).toBeLessThanOrEqual(1_000);
  });
});
