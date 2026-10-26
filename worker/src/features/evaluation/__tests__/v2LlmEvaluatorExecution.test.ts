import { describe, expect, it } from "vitest";
import {
  LangfuseInternalTraceEnvironment,
  ScoreBody,
} from "@langfuse/shared/src/server";
import {
  buildEvaluatorTraceSinkParams,
  toV2Scores,
  type V2EvaluatorVersionForExecution,
} from "../v2LlmEvaluatorExecution";
import { buildV2ScoreEvent } from "../v2ScorePersistence";

/**
 * Unit tests for the v2-native executor's pure parts.
 *
 * The important guarantee is the second block: whatever `toV2Scores` produces must
 * be a VALID ingestion score body for its data type (we build the body for three
 * different shapes, so a wrong pairing — e.g. a numeric `value` on a categorical
 * score — has to fail here rather than in production ingestion).
 */

const JOB = {
  jobInputTraceId: "trace-1",
  jobInputObservationId: null,
} as unknown as Parameters<typeof buildV2ScoreEvent>[0]["job"];

describe("toV2Scores", () => {
  it("maps a numeric output to one numeric score", () => {
    const scores = toV2Scores({
      output: { dataType: "NUMERIC", score: 4, reasoning: "solid" },
      scoreName: "Quality",
      configId: "rule-1",
      comment: "solid",
    });

    expect(scores).toEqual([
      {
        name: "Quality",
        value: 4,
        dataType: "NUMERIC",
        comment: "solid",
        configId: "rule-1",
      },
    ]);
  });

  it("maps a boolean output to a 0/1 score (our ingestion contract)", () => {
    const yes = toV2Scores({
      output: { dataType: "BOOLEAN", score: true, reasoning: "ok" },
      scoreName: "Is harmful",
      configId: "rule-1",
      comment: "ok",
    });
    const no = toV2Scores({
      output: { dataType: "BOOLEAN", score: false, reasoning: "ok" },
      scoreName: "Is harmful",
      configId: "rule-1",
      comment: "ok",
    });

    expect(yes[0]?.value).toBe(1);
    expect(yes[0]?.dataType).toBe("BOOLEAN");
    expect(no[0]?.value).toBe(0);
  });

  it("emits one score per categorical match", () => {
    const scores = toV2Scores({
      output: {
        dataType: "CATEGORICAL",
        matches: ["refund", "shipping"],
        reasoning: "two topics",
      },
      scoreName: "Topic",
      configId: "rule-1",
      comment: "two topics",
    });

    expect(scores.map((s) => s.value)).toEqual(["refund", "shipping"]);
    expect(scores.every((s) => s.dataType === "CATEGORICAL")).toBe(true);
  });
});

describe("buildV2ScoreEvent", () => {
  const cases = [
    ["NUMERIC", 4, "NUMERIC"],
    ["BOOLEAN", 1, "BOOLEAN"],
    ["CATEGORICAL", "refund", "CATEGORICAL"],
  ] as const;

  for (const [label, value, dataType] of cases) {
    it(`produces an ingestion-valid ${label} score body`, () => {
      const event = buildV2ScoreEvent({
        eventId: "event-1",
        scoreId: "score-1",
        score: {
          name: "Quality",
          value,
          dataType,
          comment: "why",
          configId: "rule-1",
        },
        job: JOB,
        environment: "default",
        executionTraceId: "trace-exec-1",
        metadata: { job_execution_id: "job-1", evaluator_id: "evaluator-1" },
      });

      expect(event.type).toBe("score-create");

      const parsed = ScoreBody.safeParse(event.body);
      if (!parsed.success) {
        throw new Error(
          `score body rejected: ${JSON.stringify(parsed.error.issues, null, 2)}`,
        );
      }
      expect(parsed.success).toBe(true);
      expect(event.body.dataType).toBe(dataType);
      expect(event.body.value).toBe(value);
      expect(event.body.source).toBe("EVAL");
      expect(event.body.executionTraceId).toBe("trace-exec-1");
      // Regression guard: the body's configId must stay null. Ingestion treats it
      // as a legacy score config id, throws for the v2 rule id, and swallows the
      // score — the job still ends COMPLETED, so only Doris reveals the loss.
      expect(event.body.configId).toBeNull();
      expect(event.body.metadata).toMatchObject({ evaluation_rule_id: "rule-1" });
    });
  }
});

describe("buildEvaluatorTraceSinkParams", () => {
  it("uses the reserved judge environment so the trace is actually written", () => {
    // `fetchLLMCompletion` skips internal traces whose environment lacks the
    // `langfuse-` prefix, so passing the eval TARGET's environment would silently
    // lose every execution trace (and, if it were written, re-open an eval loop).
    const traceSink = buildEvaluatorTraceSinkParams({
      projectId: "project-1",
      executionTraceId: "trace-exec-1",
      traceName: "Execute evaluator: Quality",
      metadata: { job_execution_id: "job-1" },
    });

    expect(traceSink.environment).toBe(
      LangfuseInternalTraceEnvironment.LLMJudge,
    );
    expect(traceSink.environment.startsWith("langfuse")).toBe(true);
    expect(traceSink).toMatchObject({
      targetProjectId: "project-1",
      traceId: "trace-exec-1",
      traceName: "Execute evaluator: Quality",
    });
  });
});

describe("v2 executor input contract", () => {
  it("keeps the version fields the executor reads", () => {
    // Compile-time shape guard: the resolver in evalService hands exactly these.
    const version: V2EvaluatorVersionForExecution = {
      id: "version-1",
      version: 2,
      prompt: "prompt",
      promptMessages: [{ role: "user", content: "hi" }],
      vars: ["input"],
      provider: "openai",
      model: "gpt-4o-mini",
      modelParams: { temperature: 0 },
      outputDefinition: { dataType: "NUMERIC" },
    };

    expect(version.vars).toEqual(["input"]);
  });
});
