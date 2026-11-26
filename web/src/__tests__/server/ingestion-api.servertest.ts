import { randomUUID } from "crypto";
import { makeAPICall } from "@/src/__tests__/test-utils";
import waitForExpect from "wait-for-expect";
import { getScoreById } from "@langfuse/shared/src/server";

const projectId = "7a88fb47b4e243b8a06ca5ce950dc53a";

describe("/api/public/ingestion API Endpoint", () => {
  it("rejects legacy v3 trace-create events in OTel-only fork", async () => {
    const response = await makeAPICall("POST", "/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: new Date().toISOString(),
          body: {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
          },
        },
      ],
    });

    expect(response.status).toBe(400);
  });

  it.each([
    [
      "plain",
      {
        id: randomUUID(),
        type: "score-create",
        timestamp: new Date().toISOString(),
        body: {
          id: randomUUID(),
          name: "score-name",
          traceId: randomUUID(),
          value: 100.5,
          observationId: randomUUID(),
        },
      },
    ],
    [
      "non-default-environment",
      {
        id: randomUUID(),
        type: "score-create",
        timestamp: new Date().toISOString(),
        body: {
          id: randomUUID(),
          name: "score-name",
          traceId: randomUUID(),
          value: 100.5,
          observationId: randomUUID(),
          environment: "production",
        },
      },
    ],
  ])(
    "should create scores via the ingestion API (%s)",
    async (_name: string, entity: any) => {
      const response = await makeAPICall("POST", "/api/public/ingestion", {
        batch: [entity],
      });

      expect(response.status).toBe(207);

      await waitForExpect(async () => {
        const score = await getScoreById({
          projectId,
          scoreId: entity.body.id,
        });
        expect(score).toBeDefined();
        expect(score!.id).toBe(entity.body.id);
        expect(score!.projectId).toBe(projectId);
        expect(score!.value).toEqual(100.5);
        expect(score!.environment).toEqual(
          entity.body?.environment ?? "default",
        );
      });
    },
  );

  it.each([
    "langfuse-test",
    ".invalidcharacter!",
    "incrediblylongstringwithmorethan40characters",
  ])(
    "should fail for invalid environments (%s)",
    async (environment: string) => {
      const entity = {
        id: randomUUID(),
        type: "score-create",
        timestamp: new Date().toISOString(),
        body: {
          id: randomUUID(),
          name: "score-name",
          traceId: randomUUID(),
          value: 100.5,
          observationId: randomUUID(),
          environment,
        },
      };

      const response = await makeAPICall("POST", "/api/public/ingestion", {
        batch: [entity],
      });

      expect(response.status).toBe(207);
      expect(response.body.errors[0].status).toBe(400);
    },
  );

  it.each([
    ["string", { testId: "this is a string metadata" }],
    ["big-number", { testId: "1983516295378495150" }],
    ["small-number", { testId: 5 }],
    ["float-number", { testId: 5.5 }],
  ])(
    "#6123: should treat %s metadata for scores as such",
    async (_type, metadataValue) => {
      const scoreId = randomUUID();
      const traceId = randomUUID();

      const entity = {
        id: randomUUID(),
        type: "score-create",
        timestamp: new Date().toISOString(),
        body: {
          id: scoreId,
          name: "score-name",
          traceId: traceId,
          value: 100.5,
          metadata: metadataValue,
        },
      };

      const response = await makeAPICall("POST", "/api/public/ingestion", {
        batch: [entity],
      });

      expect(response.status).toBe(207);

      await waitForExpect(async () => {
        const score = await getScoreById({ projectId, scoreId });
        expect(score).toBeDefined();
        expect(score!.id).toBe(scoreId);
        expect(JSON.stringify(score!.metadata)).toBe(
          JSON.stringify(metadataValue),
        );
      });
    },
  );

  it("#4900: should clear score comment on update with `null`", async () => {
    const scoreId = randomUUID();
    const score1 = {
      id: randomUUID(),
      type: "score-create",
      timestamp: new Date().toISOString(),
      body: {
        id: scoreId,
        name: "score-name",
        traceId: randomUUID(),
        value: 100.5,
        observationId: randomUUID(),
        comment: "Foo Bar",
      },
    };

    const score2 = {
      id: randomUUID(),
      type: "score-create",
      timestamp: new Date(Date.now() + 1000).toISOString(),
      body: {
        id: scoreId,
        name: "score-name",
        traceId: randomUUID(),
        value: 100.5,
        observationId: randomUUID(),
        comment: null, // Explicitly set to null to clear the comment
      },
    };

    const response = await makeAPICall("POST", "/api/public/ingestion", {
      batch: [score1, score2],
    });

    expect(response.status).toBe(207);

    await waitForExpect(async () => {
      const score = await getScoreById({ projectId, scoreId });
      expect(score).toBeDefined();
      expect(score!.id).toBe(scoreId);
      expect(score!.projectId).toBe(projectId);
      expect(score!.value).toEqual(100.5);
      expect(score!.comment).toBe(null);
    });
  }, 10000);
});
