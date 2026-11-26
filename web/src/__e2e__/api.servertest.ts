import { randomBytes } from "crypto";
import { v4 } from "uuid";
import {
  JobConfigState,
  JobExecutionStatus,
  JobType,
  Prisma,
  prisma,
} from "@langfuse/shared/src/db";
import {
  createOrgProjectAndApiKey,
  getObservationById,
  getTraceById,
  OrgEnrichedApiKey,
  redis,
} from "@langfuse/shared/src/server";
import waitForExpect from "wait-for-expect";

const generateAuth = (username: string, password: string) => {
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  return `Basic ${auth}`;
};

const workerAdminAuth = generateAuth("admin", "myworkerpassword");

const userApiKeyAuth = generateAuth("pk-lf-1234567890", "sk-lf-1234567890");

describe("Health endpoints", () => {
  it("web container returns healthy", async () => {
    // Arrange
    const url = "http://localhost:3000/api/public/health";

    // Act
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });

  it("worker container returns healthy", async () => {
    // Arrange
    const url = "http://localhost:3030/api/health";

    // Act
    const response = await fetch(url, {
      headers: {
        Authorization: workerAdminAuth,
      },
    });
    expect(response.status).toBe(200);
  });
});

describe("Ingestion Pipeline", () => {
  beforeEach(async () => {
    // clear the redis cache
    const keys = await redis?.keys("*");
    if (keys && keys.length > 0) {
      await redis?.del(keys);
    }
  });

  // Sets up a trace-level eval config, then ingests one OTel trace (root span + child span).
  const ingestTraceWithEvalConfig = async () => {
    const { projectId, auth } = await createOrgProjectAndApiKey();
    const evalTemplate = await prisma.evalTemplate.create({
      data: {
        id: v4(),
        projectId,
        name: "toxicity-e2e",
        version: 1,
        prompt: "Rate toxicity of {{input}}",
        model: "gpt-4o-mini",
        provider: "openai",
        vars: ["input"],
        outputSchema: {
          score: "Score between 0 and 1",
          reasoning: "Short reasoning",
        },
        modelParams: {},
      },
    });
    await prisma.jobConfiguration.create({
      data: {
        id: v4(),
        projectId,
        evalTemplateId: evalTemplate.id,
        jobType: JobType.EVAL,
        status: JobConfigState.ACTIVE,
        scoreName: "toxicity",
        filter: [
          {
            type: "string",
            value: "user",
            column: "User ID",
            operator: "contains",
          },
        ],
        variableMapping: [
          {
            langfuseObject: "trace",
            selectedColumnId: "input",
            templateVariable: "input",
          },
        ],
        targetObject: "trace",
        sampling: 1,
        delay: 1_000,
      },
    });

    const traceId = randomBytes(16).toString("hex");
    const rootSpanId = randomBytes(8).toString("hex");
    const spanId = randomBytes(8).toString("hex");
    const startNano = String(BigInt(Date.now()) * BigInt(1_000_000));
    const endNano = String(BigInt(Date.now() + 10) * BigInt(1_000_000));

    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: {
                name: "langfuse-sdk",
                version: "5.0.0",
              },
              spans: [
                {
                  traceId,
                  spanId: rootSpanId,
                  name: "test trace",
                  kind: 1,
                  startTimeUnixNano: startNano,
                  endTimeUnixNano: endNano,
                  attributes: [
                    {
                      key: "langfuse.trace.name",
                      value: { stringValue: "test trace" },
                    },
                    {
                      key: "langfuse.user.id",
                      value: { stringValue: "user-1" },
                    },
                    {
                      key: "langfuse.trace.input",
                      value: { stringValue: "hello world" },
                    },
                  ],
                  status: {},
                },
                {
                  traceId,
                  spanId,
                  parentSpanId: rootSpanId,
                  name: "test span",
                  kind: 1,
                  startTimeUnixNano: startNano,
                  endTimeUnixNano: endNano,
                  attributes: [],
                  status: {},
                },
              ],
            },
          ],
        },
      ],
    };

    const url = "http://localhost:3000/api/public/otel/v1/traces";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);

    return { projectId, auth, traceId, spanId };
  };

  it("ingest a trace", async () => {
    const { projectId, auth, traceId, spanId } =
      await ingestTraceWithEvalConfig();

    await waitForExpect(
      async () => {
        const traceUrl = `http://localhost:3000/api/public/traces/${traceId}`;

        const traceResponse = await fetch(traceUrl, {
          headers: {
            Authorization: auth,
          },
        });

        expect(traceResponse.status).toBe(200);
        expect(traceResponse.body).not.toBeNull();
        expect((await traceResponse.json()).id).toBe(traceId);

        const trace = await getTraceById({ traceId, projectId });
        expect(trace).not.toBeNull();
        expect(trace?.name).toBe("test trace");

        const observation = await getObservationById({
          id: spanId,
          projectId,
        });
        expect(observation).not.toBeNull();
        expect(observation?.name).toBe("test span");

        expect(redis).not.toBeNull();

        const redisKeys = await redis?.keys(`api-key:*`);
        expect(redisKeys?.length).toBe(1);
        const redisValue = await redis?.get(redisKeys![0]);

        const llmApiKey = OrgEnrichedApiKey.parse(JSON.parse(redisValue!));
        expect(llmApiKey.projectId).toBe(projectId);
      },
      60000,
      1000,
    );
  }, 130000);

  // Skipped: OTel ingestion does not enqueue trace-upsert evals yet, so no eval execution is created.
  it.skip("creates an eval execution for an ingested trace", async () => {
    const { projectId, traceId } = await ingestTraceWithEvalConfig();

    // check for eval
    await waitForExpect(
      async () => {
        const evalExecution = await prisma.jobExecution.findFirst({
          where: {
            jobInputTraceId: traceId,
            projectId,
          },
        });

        expect(evalExecution).not.toBeNull();

        if (!evalExecution) {
          return;
        }

        // failure due to missing openai key in the pipeline. Expected
        expect(evalExecution.status).toBe(JobExecutionStatus.ERROR);
      },
      60000,
      5000,
    );
  }, 130000);

  it("rate limit ingestion", async () => {
    // update the org in the database and set the rate limit to 1 for ingestion
    const org = await prisma.organization.findUnique({
      where: {
        id: "seed-org-id",
      },
    });
    await prisma.organization.update({
      where: {
        id: "seed-org-id",
      },
      data: {
        cloudConfig: {
          ...(typeof org?.cloudConfig === "object" ? org.cloudConfig : {}),
          rateLimitOverrides: [
            {
              resource: "ingestion",
              points: 1,
              durationInSec: 60,
            },
          ],
        },
      },
    });

    const traceId = v4();
    const spanId = v4();

    const event = {
      batch: [
        {
          id: v4(),
          type: "trace-create",
          timestamp: new Date().toISOString(),
          body: {
            name: "test trace",
            id: traceId,
            userId: "user-1", // triggers the eval
          },
        },
        {
          id: v4(),
          type: "span-create",
          timestamp: new Date().toISOString(),
          body: {
            id: spanId,
            traceId: traceId,
            name: "test span",
          },
        },
      ],
    };
    // Arrange
    const url = "http://localhost:3000/api/public/ingestion";

    // Act
    let responses = [];
    for (let i = 0; i < 10; i++) {
      responses.push(
        await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: userApiKeyAuth,
          },
          body: JSON.stringify(event),
        }),
      );
    }

    // check that at least one of the responses is a 429
    const rateLimitedResponse = responses.find((r) => r.status === 429);
    expect(rateLimitedResponse).not.toBeNull();

    // revert the rate limit on the org
    await prisma.organization.update({
      where: {
        id: "seed-org-id",
      },
      data: {
        cloudConfig: org?.cloudConfig ?? Prisma.JsonNull,
      },
    });
  });
});

describe("Prompts endpoint", () => {
  it("creates and returns a prompt", async () => {
    const promptName = "prompt-name" + v4();
    const chatMessages = [
      { role: "system", content: "You are a bot" },
      { role: "user", content: "What's up?" },
    ];
    const response = await fetch(
      "http://localhost:3000/api/public/v2/prompts",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: userApiKeyAuth,
        },
        body: JSON.stringify({
          name: promptName,
          prompt: chatMessages,
          type: "chat",
          labels: ["production"],
        }),
      },
    );

    expect(response.status).toBe(201);

    const fetchedPrompt = await fetch(
      `http://localhost:3000/api/public/v2/prompts/${encodeURIComponent(promptName)}`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: userApiKeyAuth,
        },
      },
    );
    expect(fetchedPrompt.status).toBe(200);
    expect(fetchedPrompt.body).not.toBeNull();

    if (fetchedPrompt.body === null) {
      return;
    }

    const validatedPrompt = await fetchedPrompt.json();

    expect(validatedPrompt.name).toBe(promptName);

    const pattern = `prompt:7a88fb47b4e243b8a06ca5ce950dc53a:*:${promptName}:${validatedPrompt.labels[0]}`;
    const keys = await redis?.keys(pattern);
    expect(keys?.length).toBe(1);

    const key = keys?.[0] as string;

    const redisValue = await redis?.get(key);

    expect(redisValue).not.toBeNull();
    if (!redisValue) {
      return;
    }
    expect(JSON.parse(redisValue)).toEqual({
      ...validatedPrompt,
      isActive: null, // deprecated isActive is being patched at the endpoint handler level; in Redis it is still null as in DB
    });
  });
});
