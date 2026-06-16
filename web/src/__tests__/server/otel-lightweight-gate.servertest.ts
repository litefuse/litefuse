import { randomBytes } from "crypto";
import { makeAPICall } from "@/src/__tests__/test-utils";
import waitForExpect from "wait-for-expect";
import { getObservationById, getTraceById } from "@langfuse/shared/src/server";

const projectId = "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a";

const buildPayload = () => {
  const traceId = randomBytes(16);
  const spanId = randomBytes(8);
  return {
    traceId,
    spanId,
    payload: {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: {
                name: "langfuse-sdk",
                version: "4.0.0",
                attributes: [
                  {
                    key: "public_key",
                    value: { stringValue: "pk-lf-1234567890" },
                  },
                ],
              },
              spans: [
                {
                  traceId,
                  spanId,
                  name: "gate-test-span",
                  kind: 1,
                  startTimeUnixNano: {
                    low: 466848096,
                    high: 406528574,
                    unsigned: true,
                  },
                  endTimeUnixNano: {
                    low: 467248096,
                    high: 406528574,
                    unsigned: true,
                  },
                  attributes: [],
                  status: {},
                },
              ],
            },
          ],
        },
      ],
    },
  };
};

describe("Litefuse Lightweight OTel SDK gate", () => {
  it("accepts Python SDK >= 4.0.0", async () => {
    const { traceId, spanId, payload } = buildPayload();
    const response = await makeAPICall(
      "POST",
      "/api/public/otel/v1/traces",
      payload,
      undefined,
      {
        "x-langfuse-sdk-name": "python",
        "x-langfuse-sdk-version": "4.0.0",
      },
    );
    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId: traceId.toString("hex"),
      });
      expect(trace).toBeDefined();
      const observation = await getObservationById({
        projectId,
        id: spanId.toString("hex"),
      });
      expect(observation).toBeDefined();
    }, 25_000);
  }, 30_000);

  it("accepts JS SDK >= 5.0.0", async () => {
    const { traceId, spanId, payload } = buildPayload();
    const response = await makeAPICall(
      "POST",
      "/api/public/otel/v1/traces",
      payload,
      undefined,
      {
        "x-langfuse-sdk-name": "javascript",
        "x-langfuse-sdk-version": "5.0.0",
      },
    );
    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId: traceId.toString("hex"),
      });
      expect(trace).toBeDefined();
      const observation = await getObservationById({
        projectId,
        id: spanId.toString("hex"),
      });
      expect(observation).toBeDefined();
    }, 25_000);
  }, 30_000);

  it("accepts x-langfuse-ingestion-version=4", async () => {
    const { traceId, payload } = buildPayload();
    const response = await makeAPICall(
      "POST",
      "/api/public/otel/v1/traces",
      payload,
      undefined,
      { "x-langfuse-ingestion-version": "4" },
    );
    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const trace = await getTraceById({
        projectId,
        traceId: traceId.toString("hex"),
      });
      expect(trace).toBeDefined();
    }, 25_000);
  }, 30_000);

  it("rejects JS SDK v3", async () => {
    const { payload } = buildPayload();
    const response = await makeAPICall<{ error?: string }>(
      "POST",
      "/api/public/otel/v1/traces",
      payload,
      undefined,
      {
        "x-langfuse-sdk-name": "javascript",
        "x-langfuse-sdk-version": "3.99.0",
      },
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Litefuse Lightweight requires");
  });

  it("rejects Python SDK v2", async () => {
    const { payload } = buildPayload();
    const response = await makeAPICall<{ error?: string }>(
      "POST",
      "/api/public/otel/v1/traces",
      payload,
      undefined,
      {
        "x-langfuse-sdk-name": "python",
        "x-langfuse-sdk-version": "2.60.3",
      },
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Litefuse Lightweight requires");
  });

  it("rejects requests with no SDK headers", async () => {
    const { payload } = buildPayload();
    const response = await makeAPICall<{ error?: string }>(
      "POST",
      "/api/public/otel/v1/traces",
      payload,
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Litefuse Lightweight requires");
  });

  it("returns 410 for /api/public/ingestion", async () => {
    const response = await makeAPICall<{ error?: string; message?: string }>(
      "POST",
      "/api/public/ingestion",
      { batch: [] },
    );
    expect(response.status).toBe(410);
    expect(response.body.error).toBe("Gone");
    expect(response.body.message).toContain("/api/public/otel/v1/traces");
  });
});
