import { describe, expect, it, vi } from "vitest";
import { JobExecutionStatus } from "@prisma/client";
import { ScoreBody } from "@langfuse/shared/src/server";
import { createMockEvalExecutionDeps } from "../evalExecutionDeps";
import { buildV2ScoreEvent, persistV2Scores } from "../v2ScorePersistence";

/**
 * Tests for the shared v2 score writer.
 *
 * The decision model and the LLM judge both persist through this module, so what
 * matters here is: every score is uploaded AND enqueued, the job execution gets the
 * FIRST score as its primary output, and each event is valid for its data type.
 */

const JOB = {
  jobInputTraceId: "trace-1",
  jobInputObservationId: "obs-1",
} as unknown as Parameters<typeof buildV2ScoreEvent>[0]["job"];

describe("buildV2ScoreEvent", () => {
  it.each([
    ["NUMERIC", 0.7],
    ["BOOLEAN", 1],
    ["CATEGORICAL", "refund"],
  ] as const)("is a valid ingestion body for %s", (dataType, value) => {
    const event = buildV2ScoreEvent({
      eventId: "event-1",
      scoreId: "score-1",
      score: {
        name: "Topic",
        value,
        dataType,
        comment: "because",
        configId: "rule-1",
        metadata: { question_id: "q1" },
      },
      job: JOB,
      environment: "production",
      executionTraceId: "trace-exec",
      metadata: { evaluator_id: "evaluator-1" },
    });

    const parsed = ScoreBody.safeParse(event.body);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    }
    // Per-score metadata is merged with the execution metadata, and the rule id
    // travels in metadata too: `configId` in the body means a legacy score config
    // and ingestion silently drops a score whose configId is unknown.
    expect(event.body.metadata).toMatchObject({
      question_id: "q1",
      evaluator_id: "evaluator-1",
      evaluation_rule_id: "rule-1",
    });
    expect(event.body.observationId).toBe("obs-1");
    expect(event.body.configId).toBeNull();
  });
});

describe("persistV2Scores", () => {
  function deps() {
    const uploadScore = vi.fn(async () => {});
    const enqueueScoreIngestion = vi.fn(async () => {});
    const updateJobExecution = vi.fn(async () => {});
    return {
      mock: createMockEvalExecutionDeps({
        uploadScore,
        enqueueScoreIngestion,
        updateJobExecution,
      }),
      uploadScore,
      enqueueScoreIngestion,
      updateJobExecution,
    };
  }

  it("uploads and enqueues every score, then completes the job with the first one", async () => {
    const { mock, uploadScore, enqueueScoreIngestion, updateJobExecution } =
      deps();

    const { scoreIds } = await persistV2Scores({
      deps: mock,
      projectId: "project-1",
      jobExecutionId: "job-1",
      job: JOB,
      scores: [
        { name: "Q1", value: 1, dataType: "NUMERIC", configId: "rule-1" },
        { name: "Q2", value: "yes", dataType: "CATEGORICAL", configId: "rule-1" },
      ],
      environment: "default",
      executionTraceId: "trace-exec",
      metadata: { evaluator_id: "evaluator-1" },
    });

    expect(scoreIds).toHaveLength(2);
    expect(uploadScore).toHaveBeenCalledTimes(2);
    expect(enqueueScoreIngestion).toHaveBeenCalledTimes(2);
    expect(updateJobExecution).toHaveBeenCalledTimes(1);

    // Each score event pairs its own id/value with the enqueued score id.
    const firstEventBody = uploadScore.mock.calls[0]![0].event.body;
    expect(firstEventBody.value).toBe(1);
    expect(firstEventBody.dataType).toBe("NUMERIC");
    expect(enqueueScoreIngestion.mock.calls[0]![0].scoreId).toBe(scoreIds[0]);

    expect(updateJobExecution.mock.calls[0]![0]).toMatchObject({
      id: "job-1",
      projectId: "project-1",
      data: {
        status: JobExecutionStatus.COMPLETED,
        jobOutputScoreId: scoreIds[0],
        executionTraceId: "trace-exec",
      },
    });
  });

  it("refuses to complete a job that produced no scores", async () => {
    const { mock, updateJobExecution } = deps();

    await expect(
      persistV2Scores({
        deps: mock,
        projectId: "project-1",
        jobExecutionId: "job-1",
        job: JOB,
        scores: [],
        environment: "default",
        executionTraceId: "trace-exec",
        metadata: {},
      }),
    ).rejects.toThrow(/produced no scores/);
    expect(updateJobExecution).not.toHaveBeenCalled();
  });

  it("surfaces an ingestion failure instead of completing the job", async () => {
    const { mock, updateJobExecution } = deps();
    mock.enqueueScoreIngestion = vi.fn(async () => {
      throw new Error("Queue unavailable");
    });

    await expect(
      persistV2Scores({
        deps: mock,
        projectId: "project-1",
        jobExecutionId: "job-1",
        job: JOB,
        scores: [{ name: "Q1", value: 1, dataType: "NUMERIC" }],
        environment: "default",
        executionTraceId: "trace-exec",
        metadata: {},
      }),
    ).rejects.toThrow(/Failed to write score/);
    expect(updateJobExecution).not.toHaveBeenCalled();
  });
});
