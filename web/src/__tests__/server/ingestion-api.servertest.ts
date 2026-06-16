import { randomUUID } from "crypto";
import { makeAPICall } from "@/src/__tests__/test-utils";
import waitForExpect from "wait-for-expect";
import { getScoreById } from "@langfuse/shared/src/server";

const projectId = "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a";

const buildScoreBatchEvent = (
  overrides: Partial<{ scoreId: string; traceId: string }> = {},
) => {
  const scoreId = overrides.scoreId ?? randomUUID();
  const traceId = overrides.traceId ?? randomUUID();
  return {
    scoreId,
    traceId,
    envelope: {
      id: randomUUID(),
      type: "score-create",
      timestamp: new Date().toISOString(),
      body: {
        id: scoreId,
        traceId,
        name: "lightweight-ingestion-test",
        value: 0.75,
        dataType: "NUMERIC",
      },
    },
  };
};

describe("/api/public/ingestion (Litefuse Lightweight: score-only whitelist)", () => {
  it("rejects non-POST methods with 405", async () => {
    const response = await makeAPICall<{ message: string }>(
      "GET",
      "/api/public/ingestion",
    );
    expect(response.status).toBe(405);
  });

  it("accepts a score-create batch and writes to Doris (207)", async () => {
    const { scoreId, traceId, envelope } = buildScoreBatchEvent();
    const response = await makeAPICall<{
      successes: { id: string; status: number }[];
      errors: unknown[];
    }>("POST", "/api/public/ingestion", { batch: [envelope] });

    expect(response.status).toBe(207);
    expect(response.body.errors).toHaveLength(0);
    expect(response.body.successes).toHaveLength(1);

    await waitForExpect(async () => {
      const score = await getScoreById({ projectId, scoreId });
      expect(score).toBeDefined();
      expect(score?.traceId).toBe(traceId);
      expect(score?.value).toBe(0.75);
    }, 20_000);
  }, 30_000);

  it("accepts an sdk-log event as a no-op (207)", async () => {
    const response = await makeAPICall<{
      successes: { id: string; status: number }[];
      errors: unknown[];
    }>("POST", "/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "sdk-log",
          timestamp: new Date().toISOString(),
          body: { log: { sdkVersion: "5.3.0", message: "hello" } },
        },
      ],
    });

    // sdk-log events are dropped inside processEventBatch (no Doris write),
    // so they show up as neither a success nor an error — the call simply
    // returns 207 with empty arrays.
    expect(response.status).toBe(207);
    expect(response.body.errors).toHaveLength(0);
  });

  it("rejects trace-create with 400 and an OTel upgrade hint", async () => {
    const response = await makeAPICall<{
      error: string;
      message: string;
      rejectedTypes?: string[];
    }>("POST", "/api/public/ingestion", {
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: new Date().toISOString(),
          body: { id: randomUUID(), name: "should-not-land" },
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("UnsupportedEventTypes");
    expect(response.body.message).toContain("/api/public/otel/v1/traces");
    expect(response.body.rejectedTypes).toEqual(["trace-create"]);
  });

  it("rejects observation/generation/span/event-create with 400", async () => {
    const offendingTypes = [
      "observation-create",
      "generation-create",
      "span-create",
      "event-create",
    ];
    const response = await makeAPICall<{
      error: string;
      rejectedTypes?: string[];
    }>("POST", "/api/public/ingestion", {
      batch: offendingTypes.map((type) => ({
        id: randomUUID(),
        type,
        timestamp: new Date().toISOString(),
        body: { id: randomUUID() },
      })),
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("UnsupportedEventTypes");
    expect(new Set(response.body.rejectedTypes)).toEqual(
      new Set(offendingTypes),
    );
  });

  it("rejects mixed batch (score-create + trace-create) without writing the score", async () => {
    const { scoreId, envelope: scoreEnvelope } = buildScoreBatchEvent();
    const response = await makeAPICall<{
      error: string;
      rejectedTypes?: string[];
    }>("POST", "/api/public/ingestion", {
      batch: [
        scoreEnvelope,
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: new Date().toISOString(),
          body: { id: randomUUID(), name: "should-not-land" },
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("UnsupportedEventTypes");
    expect(response.body.rejectedTypes).toEqual(["trace-create"]);

    // Score must NOT have been written — the whole batch is rejected atomically.
    const score = await getScoreById({ projectId, scoreId });
    expect(score).toBeUndefined();
  }, 15_000);

  it("rejects events with missing/malformed type field", async () => {
    const response = await makeAPICall<{
      error: string;
      rejectedTypes?: string[];
    }>("POST", "/api/public/ingestion", {
      batch: [{ id: randomUUID(), body: {} }],
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("UnsupportedEventTypes");
    expect(response.body.rejectedTypes).toContain(
      "<missing-or-malformed-type>",
    );
  });

  it("returns 400 for malformed body (no batch field)", async () => {
    const response = await makeAPICall<{ message: string; errors: string[] }>(
      "POST",
      "/api/public/ingestion",
      { notABatch: [] },
    );
    expect(response.status).toBe(400);
  });
});
