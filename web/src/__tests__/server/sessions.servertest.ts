/** @jest-environment node */

import { makeAPICall } from "@/src/__tests__/test-utils";
import { prisma } from "@langfuse/shared/src/db";
import { createOrgProjectAndApiKey } from "@langfuse/shared/src/server";
import { randomBytes, randomUUID } from "crypto";
import waitForExpect from "wait-for-expect";

describe("Create and get sessions", () => {
  it("should create a session via an OTel trace", async () => {
    const { auth, projectId } = await createOrgProjectAndApiKey();
    const sessionId = `session-${randomUUID()}`;
    const traceId = randomBytes(16).toString("hex");
    const spanId = randomBytes(8).toString("hex");
    const startNano = String(BigInt(Date.now()) * BigInt(1_000_000));
    const endNano = String(BigInt(Date.now() + 10) * BigInt(1_000_000));

    const response = await makeAPICall(
      "POST",
      "/api/public/otel/v1/traces",
      {
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                scope: { name: "langfuse-sdk", version: "5.0.0" },
                spans: [
                  {
                    traceId,
                    spanId,
                    name: "trace-name",
                    kind: 1,
                    startTimeUnixNano: startNano,
                    endTimeUnixNano: endNano,
                    attributes: [
                      {
                        key: "langfuse.trace.name",
                        value: { stringValue: "trace-name" },
                      },
                      {
                        key: "langfuse.session.id",
                        value: { stringValue: sessionId },
                      },
                    ],
                    status: {},
                  },
                ],
              },
            ],
          },
        ],
      },
      auth,
      { "x-langfuse-ingestion-version": "4" },
    );

    expect(response.status).toBe(200);

    await waitForExpect(async () => {
      const dbSession = await prisma.traceSession.findFirst({
        where: {
          id: sessionId,
        },
      });

      expect(dbSession).not.toBeNull();
      expect(dbSession).toMatchObject({
        id: sessionId,
        projectId,
      });
    }, 45_000);
  }, 60_000);
});
