import { beforeEach, describe, expect, it, vi } from "vitest";
import { type JobExecution } from "@prisma/client";
import { UnrecoverableError } from "../../../errors/UnrecoverableError";
import { createW3CTraceId } from "../../utils";
import { type EvalExecutionDeps } from "../evalExecutionDeps";

/**
 * The executors have to record a FAILED execution as an internal execution trace,
 * because that trace is the only per-evaluator ledger the "Last 5 runs" column has
 * (`getRecentEvaluatorExecutionTraces` groups `spans_<projectId>` by
 * `metadata['evaluator_id']`). A run that throws before writing anything would be
 * invisible instead of red.
 *
 * Both cases below fail BEFORE any model call, so this test costs nothing:
 *   * decision model: the model connection does not resolve (blocked evaluator),
 *   * LLM judge: the evaluator version has no output definition.
 */
const mocks = vi.hoisted(() => ({
  writeFailureTrace: vi.fn().mockResolvedValue(undefined),
  writeDecisionModelTrace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../v2InternalTrace", () => ({
  writeEvaluatorExecutionFailureTrace: mocks.writeFailureTrace,
  writeDecisionModelExecutionTrace: mocks.writeDecisionModelTrace,
}));

const { runV2DecisionModelEvaluation } = await import(
  "../v2DecisionModelExecution"
);
const { runV2LlmEvaluatorEvaluation } = await import(
  "../v2LlmEvaluatorExecution"
);

const JOB = {
  id: "job-execution-1",
  jobInputTraceId: "target-trace-1",
  jobInputObservationId: "target-observation-1",
  jobInputDatasetItemId: null,
  jobConfigurationId: "rule-1",
} as unknown as JobExecution;

function deps(overrides: Partial<EvalExecutionDeps> = {}): EvalExecutionDeps {
  return {
    fetchModelConfig: async () => ({ valid: false, error: "no such model" }),
    blockEvaluator: vi.fn().mockResolvedValue(undefined),
    updateJobExecution: vi.fn().mockResolvedValue(undefined),
    uploadScore: vi.fn().mockResolvedValue(undefined),
    enqueueScoreIngestion: vi.fn().mockResolvedValue(undefined),
    callLLM: vi.fn(),
    ...overrides,
  } as unknown as EvalExecutionDeps;
}

/** The metadata the execution trace (and the score) must carry. */
const EXPECTED_METADATA = {
  job_execution_id: "job-execution-1",
  job_configuration_id: "rule-1",
  evaluator_id: "evaluator-1",
  evaluator_version_id: "version-1",
  evaluation_rule_id: "rule-1",
  evaluation_rule_assignment_id: "assignment-1",
  target_trace_id: "target-trace-1",
  target_observation_id: "target-observation-1",
};

beforeEach(() => {
  mocks.writeFailureTrace.mockClear();
  mocks.writeDecisionModelTrace.mockClear();
});

describe("runV2DecisionModelEvaluation failure trace", () => {
  it("records the failed run and rethrows the original error", async () => {
    const error = await runV2DecisionModelEvaluation({
      projectId: "project-1",
      jobExecutionId: "job-execution-1",
      job: JOB,
      evaluatorId: "evaluator-1",
      evaluationRuleId: "rule-1",
      assignmentId: "assignment-1",
      scoreName: "send_readiness",
      version: {
        id: "version-1",
        version: 1,
        questions: [
          {
            id: "q1",
            type: "choice",
            options: [
              { value: "ready", description: "ready" },
              { value: "unsafe", description: "unsafe" },
            ],
            scoreName: "send_readiness",
            instructions: "Is it ready?",
          },
        ],
        provider: "TypeSafe",
        model: "jev-latest",
        modelParams: null,
      },
      extractedVariables: [{ var: "input", value: "hello" }],
      environment: "production",
      deps: deps(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(mocks.writeFailureTrace).toHaveBeenCalledTimes(1);
    expect(mocks.writeFailureTrace).toHaveBeenCalledWith({
      projectId: "project-1",
      executionTraceId: createW3CTraceId("job-execution-1"),
      traceName: "Execute evaluator: send_readiness",
      traceStartTime: expect.any(Date),
      metadata: EXPECTED_METADATA,
      error,
    });
    // Nothing was recorded as a successful run.
    expect(mocks.writeDecisionModelTrace).not.toHaveBeenCalled();
  });
});

describe("runV2LlmEvaluatorEvaluation failure trace", () => {
  it("records the failed run when the version has no output definition", async () => {
    const error = await runV2LlmEvaluatorEvaluation({
      projectId: "project-1",
      jobExecutionId: "job-execution-1",
      job: JOB,
      evaluatorId: "evaluator-1",
      evaluationRuleId: "rule-1",
      assignmentId: "assignment-1",
      scoreName: "send_readiness",
      version: {
        id: "version-1",
        version: 1,
        prompt: "Is it ready?",
        promptMessages: null,
        provider: "DeepSeek",
        model: "deepseek-flash",
        modelParams: null,
        outputDefinition: null,
      } as unknown as Parameters<
        typeof runV2LlmEvaluatorEvaluation
      >[0]["version"],
      variableMapping: [],
      extractedVariables: [{ var: "input", value: "hello" }],
      environment: "production",
      deps: deps(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(mocks.writeFailureTrace).toHaveBeenCalledTimes(1);
    expect(mocks.writeFailureTrace).toHaveBeenCalledWith({
      projectId: "project-1",
      executionTraceId: createW3CTraceId("job-execution-1"),
      traceName: "Execute evaluator: send_readiness",
      traceStartTime: expect.any(Date),
      metadata: EXPECTED_METADATA,
      error,
    });
  });
});
