/** @jest-environment node */

// Server tests for the new stable public REST endpoints
// (`/api/public/v2/evaluators`, `/api/public/v2/evaluation-rules`) added to
// match upstream Langfuse 4.56.0.
//
// These run the real route handlers (no HTTP server needed), the real API-key
// auth path, the real request/response schemas and the real evaluators-v2
// services against the test database. Each test creates its own org, project
// and API key, so cases stay independent and parallel-safe; no `pruneDatabase`
// call is used here (`web/src/__tests__/server` must not prune).

import { createMocks, type RequestOptions } from "node-mocks-http";
import { type NextApiRequest, type NextApiResponse } from "next";
import { createOrgProjectAndApiKey } from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import {
  Evaluator,
  ListEvaluatorsResponse,
  ListEvaluatorVersionsResponse,
} from "@/src/features/public-api/types/evaluation/evaluators";
import {
  EvaluationRule,
  ListEvaluationRulesResponse,
} from "@/src/features/public-api/types/evaluation/evaluationRules";

// The CORS middleware is irrelevant here and its `runMiddleware` wrapper only
// adds noise to the mocked request/response pair.
jest.mock("../../features/public-api/server/cors", () => ({
  __esModule: true,
  cors: (_req: unknown, _res: unknown, next: () => void) => next(),
  runMiddleware: jest.fn(async () => undefined),
}));

import evaluatorsHandler from "@/src/pages/api/public/v2/evaluators/index";
import evaluatorHandler from "@/src/pages/api/public/v2/evaluators/[evaluatorId]";
import evaluatorVersionsHandler from "@/src/pages/api/public/v2/evaluators/[evaluatorId]/versions";
import evaluationRulesHandler from "@/src/pages/api/public/v2/evaluation-rules/index";
import evaluationRuleHandler from "@/src/pages/api/public/v2/evaluation-rules/[evaluationRuleId]";

type NextHandler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

async function callHandler(params: {
  handler: NextHandler;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string>;
  body?: unknown;
  auth?: string;
}) {
  // `node-mocks-http` types the request options more narrowly than the
  // Next.js request shape this helper builds, so the options object is cast.
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: params.method,
    headers: params.auth ? { authorization: params.auth } : {},
    query: params.query ?? {},
    ...(params.body !== undefined ? { body: params.body } : {}),
  } as unknown as RequestOptions);

  await params.handler(req, res);

  return {
    status: res._getStatusCode(),
    body: res._getJSONData() as Record<string, unknown>,
  };
}

/** A provider with no LLM connection: the save preflight stays offline. */
const OFFLINE_PROVIDER = "zz-public-api-test-provider";

const llmAsJudgeBody = (name: string) => ({
  type: "llm_as_judge" as const,
  name,
  description: "Public API contract test",
  prompt: [{ role: "user", content: "Score the reply between 0 and 1." }],
  modelConfig: { provider: OFFLINE_PROVIDER, model: "zz-offline-model" },
  variableMapping: null,
  outputDefinition: {
    dataType: "NUMERIC",
    scoreReasoningInstructions: "One sentence.",
    scoreValueInstructions: "Score from 0 to 1.",
    minValue: 0,
    maxValue: 1,
  },
});

async function createEvaluator(params: { auth: string; name: string }) {
  const res = await callHandler({
    handler: evaluatorsHandler,
    method: "POST",
    body: llmAsJudgeBody(params.name),
    auth: params.auth,
  });
  expect(res.status).toBe(201);
  return Evaluator.parse(res.body);
}

describe("public API v2 evaluators + evaluation-rules", () => {
  const createdProjectIds: string[] = [];
  const createdOrgIds: string[] = [];

  const newProject = async () => {
    const { auth, projectId, orgId } = await createOrgProjectAndApiKey();
    createdProjectIds.push(projectId);
    createdOrgIds.push(orgId);
    return { auth, projectId };
  };

  afterAll(async () => {
    // Deleting the project cascades to evaluators, versions, rules and
    // assignments; the org is then empty and safe to remove.
    if (createdProjectIds.length > 0) {
      await prisma.project.deleteMany({
        where: { id: { in: createdProjectIds } },
      });
    }
    if (createdOrgIds.length > 0) {
      await prisma.organization.deleteMany({
        where: { id: { in: createdOrgIds } },
      });
    }
  });

  describe("GET/POST /api/public/v2/evaluators", () => {
    it("rejects an unauthenticated request with the structured 401 body", async () => {
      const res = await callHandler({
        handler: evaluatorsHandler,
        method: "GET",
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        message: "No authorization header",
        code: "authentication_failed",
      });
    });

    it("rejects an invalid body with the structured 400 body", async () => {
      const { auth } = await newProject();

      const res = await callHandler({
        handler: evaluatorsHandler,
        method: "POST",
        body: { name: "no type field" },
        auth,
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Invalid request body");
      expect(res.body.code).toBe("invalid_body");
      expect(
        Array.isArray((res.body.details as { issues: unknown[] }).issues),
      ).toBe(true);
    });

    it("creates an evaluator and reads it back field-for-field", async () => {
      const { auth } = await newProject();

      const created = await createEvaluator({
        auth,
        name: "contract create test",
      });

      expect(created).toMatchObject({
        type: "llm_as_judge",
        name: "contract create test",
        version: 1,
        variables: [],
        variableMapping: null,
        modelConfig: {
          provider: OFFLINE_PROVIDER,
          model: "zz-offline-model",
        },
        evaluationRuleAssignments: [],
      });

      if (created.type !== "llm_as_judge") {
        throw new Error(`unexpected evaluator type: ${created.type}`);
      }
      expect(created.outputDefinition).toMatchObject({
        dataType: "NUMERIC",
        minValue: 0,
        maxValue: 1,
      });

      const read = await callHandler({
        handler: evaluatorHandler,
        method: "GET",
        query: { evaluatorId: created.id },
        auth,
      });

      expect(read.status).toBe(200);
      expect(Evaluator.parse(read.body)).toEqual(created);
    });

    it("returns a structured 404 for an unknown evaluator id", async () => {
      const { auth } = await newProject();

      const res = await callHandler({
        handler: evaluatorHandler,
        method: "GET",
        query: { evaluatorId: "does-not-exist" },
        auth,
      });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        message: "Evaluator not found",
        code: "resource_not_found",
      });
    });

    it("lists with cursor pagination and rejects an invalid cursor", async () => {
      const { auth } = await newProject();

      const first = await createEvaluator({ auth, name: "page one" });
      const second = await createEvaluator({ auth, name: "page two" });

      const page1 = await callHandler({
        handler: evaluatorsHandler,
        method: "GET",
        query: { limit: "1" },
        auth,
      });

      expect(page1.status).toBe(200);
      const page1Body = ListEvaluatorsResponse.parse(page1.body);
      expect(page1Body.data).toHaveLength(1);
      expect(page1Body.meta.cursor).toBeDefined();

      const page2 = await callHandler({
        handler: evaluatorsHandler,
        method: "GET",
        query: { limit: "1", cursor: page1Body.meta.cursor! },
        auth,
      });

      expect(page2.status).toBe(200);
      const page2Body = ListEvaluatorsResponse.parse(page2.body);
      expect(page2Body.data).toHaveLength(1);

      expect([page1Body.data[0]!.id, page2Body.data[0]!.id].sort()).toEqual(
        [first.id, second.id].sort(),
      );

      // A malformed cursor is rejected by the cursor transform with an
      // `InvalidRequestError`, not a ZodError, so upstream answers
      // `invalid_request` (not `invalid_query`) — verified against 4.56.0.
      const invalidCursor = await callHandler({
        handler: evaluatorsHandler,
        method: "GET",
        query: { cursor: "not-base64-json" },
        auth,
      });

      expect(invalidCursor.status).toBe(400);
      expect(invalidCursor.body).toEqual({
        message: "Invalid cursor format",
        code: "invalid_request",
      });
    });

    it("lists evaluator versions", async () => {
      const { auth } = await newProject();
      const created = await createEvaluator({ auth, name: "versioned" });

      const res = await callHandler({
        handler: evaluatorVersionsHandler,
        method: "GET",
        query: { evaluatorId: created.id },
        auth,
      });

      expect(res.status).toBe(200);
      const body = ListEvaluatorVersionsResponse.parse(res.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        id: created.versionId,
        version: 1,
        type: "llm_as_judge",
      });
      expect(body.meta.cursor).toBeUndefined();
    });

    it("patches the evaluator name and deletes it", async () => {
      const { auth } = await newProject();
      const created = await createEvaluator({ auth, name: "patch me" });

      const patched = await callHandler({
        handler: evaluatorHandler,
        method: "PATCH",
        query: { evaluatorId: created.id },
        body: { name: "patched name" },
        auth,
      });

      expect(patched.status).toBe(200);
      const patchedEvaluator = Evaluator.parse(patched.body);
      expect(patchedEvaluator.name).toBe("patched name");
      // A metadata-only patch must not create a new version.
      expect(patchedEvaluator.version).toBe(1);

      const deleted = await callHandler({
        handler: evaluatorHandler,
        method: "DELETE",
        query: { evaluatorId: created.id },
        auth,
      });

      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ id: created.id });

      const afterDelete = await callHandler({
        handler: evaluatorHandler,
        method: "GET",
        query: { evaluatorId: created.id },
        auth,
      });
      expect(afterDelete.status).toBe(404);
    });

    it("rejects an unsupported method with the structured 405 body", async () => {
      const { auth } = await newProject();

      const res = await callHandler({
        handler: evaluatorsHandler,
        method: "DELETE" as never,
        auth,
      });

      expect(res.status).toBe(405);
      expect(res.body).toEqual({
        message: "Method not allowed",
        code: "method_not_allowed",
      });
    });

    it("rejects unknown and out-of-range query parameters with invalid_query", async () => {
      const { auth } = await newProject();

      // Pagination is cursor-only: `page` is not part of the contract.
      const unknownParam = await callHandler({
        handler: evaluatorsHandler,
        method: "GET",
        query: { page: "1" },
        auth,
      });
      expect(unknownParam.status).toBe(400);
      expect(unknownParam.body).toMatchObject({
        message: "Invalid query parameters",
        code: "invalid_query",
      });
      expect(JSON.stringify(unknownParam.body.details)).toContain(
        'Unrecognized key: \\"page\\"',
      );

      const tooSmall = await callHandler({
        handler: evaluatorsHandler,
        method: "GET",
        query: { limit: "0" },
        auth,
      });
      expect(tooSmall.status).toBe(400);
      expect(tooSmall.body.code).toBe("invalid_query");

      const tooLarge = await callHandler({
        handler: evaluatorsHandler,
        method: "GET",
        query: { limit: "101" },
        auth,
      });
      expect(tooLarge.status).toBe(400);
      expect(tooLarge.body.code).toBe("invalid_query");
    });
  });

  describe("GET/POST/PATCH/DELETE /api/public/v2/evaluation-rules", () => {
    it("creates an enabled rule with an assignment and reads it back", async () => {
      const { auth } = await newProject();
      const evaluator = await createEvaluator({ auth, name: "rule target" });

      const created = await callHandler({
        handler: evaluationRulesHandler,
        method: "POST",
        body: {
          name: "contract rule",
          enabled: true,
          sampling: 0.5,
          filter: [
            {
              type: "stringOptions",
              column: "environment",
              operator: "any of",
              value: ["production"],
            },
          ],
          evaluatorAssignments: [
            { evaluatorId: evaluator.id, variableMapping: null },
          ],
        },
        auth,
      });

      expect(created.status).toBe(201);
      const rule = EvaluationRule.parse(created.body);
      expect(rule).toMatchObject({
        name: "contract rule",
        enabled: true,
        sampling: 0.5,
        evaluatorAssignments: [{ evaluatorId: evaluator.id }],
      });
      expect(rule.filter).toEqual([
        {
          type: "stringOptions",
          column: "environment",
          operator: "any of",
          value: ["production"],
        },
      ]);

      // The evaluator must now report the assignment back.
      const evaluatorAfter = await callHandler({
        handler: evaluatorHandler,
        method: "GET",
        query: { evaluatorId: evaluator.id },
        auth,
      });
      expect(Evaluator.parse(evaluatorAfter.body)).toMatchObject({
        evaluationRuleAssignments: [{ evaluationRuleId: rule.id }],
      });

      const read = await callHandler({
        handler: evaluationRuleHandler,
        method: "GET",
        query: { evaluationRuleId: rule.id },
        auth,
      });
      expect(read.status).toBe(200);
      expect(EvaluationRule.parse(read.body)).toEqual(rule);
    });

    it("enforces the enabled-rule-needs-assignment refinement", async () => {
      const { auth } = await newProject();

      const res = await callHandler({
        handler: evaluationRulesHandler,
        method: "POST",
        body: {
          name: "no assignment",
          enabled: true,
          evaluatorAssignments: [],
        },
        auth,
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_body");
      expect(JSON.stringify(res.body.details)).toContain(
        "An enabled evaluation rule requires at least one evaluator assignment",
      );
    });

    it("lists, patches, disables and deletes a rule", async () => {
      const { auth } = await newProject();
      const evaluator = await createEvaluator({ auth, name: "lifecycle" });

      const created = await callHandler({
        handler: evaluationRulesHandler,
        method: "POST",
        body: {
          name: "lifecycle rule",
          enabled: false,
          evaluatorAssignments: [
            { evaluatorId: evaluator.id, variableMapping: null },
          ],
        },
        auth,
      });
      expect(created.status).toBe(201);
      const rule = EvaluationRule.parse(created.body);
      expect(rule.enabled).toBe(false);

      const list = await callHandler({
        handler: evaluationRulesHandler,
        method: "GET",
        query: { limit: "10" },
        auth,
      });
      expect(list.status).toBe(200);
      const listBody = ListEvaluationRulesResponse.parse(list.body);
      expect(listBody.data.map(({ id }) => id)).toContain(rule.id);

      const patched = await callHandler({
        handler: evaluationRuleHandler,
        method: "PATCH",
        query: { evaluationRuleId: rule.id },
        body: { enabled: true, name: "renamed rule" },
        auth,
      });
      expect(patched.status).toBe(200);
      expect(EvaluationRule.parse(patched.body)).toMatchObject({
        id: rule.id,
        name: "renamed rule",
        enabled: true,
      });

      const deleted = await callHandler({
        handler: evaluationRuleHandler,
        method: "DELETE",
        query: { evaluationRuleId: rule.id },
        auth,
      });
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ id: rule.id });

      const afterDelete = await callHandler({
        handler: evaluationRuleHandler,
        method: "GET",
        query: { evaluationRuleId: rule.id },
        auth,
      });
      expect(afterDelete.status).toBe(404);
      expect(afterDelete.body).toEqual({
        message: "Evaluation rule not found",
        code: "resource_not_found",
      });
    });

    it("rejects an empty patch body", async () => {
      const { auth } = await newProject();
      const evaluator = await createEvaluator({ auth, name: "empty patch" });

      const created = await callHandler({
        handler: evaluationRulesHandler,
        method: "POST",
        body: {
          name: "empty patch rule",
          enabled: false,
          evaluatorAssignments: [
            { evaluatorId: evaluator.id, variableMapping: null },
          ],
        },
        auth,
      });
      const rule = EvaluationRule.parse(created.body);

      const res = await callHandler({
        handler: evaluationRuleHandler,
        method: "PATCH",
        query: { evaluationRuleId: rule.id },
        body: {},
        auth,
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_body");
    });

    it("rejects an unknown filter column with the structured 400 body", async () => {
      const { auth } = await newProject();

      const res = await callHandler({
        handler: evaluationRulesHandler,
        method: "POST",
        body: {
          name: "bad column",
          enabled: false,
          filter: [
            {
              type: "stringOptions",
              column: "notAColumn",
              operator: "any of",
              value: ["x"],
            },
          ],
          evaluatorAssignments: [],
        },
        auth,
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_body");
    });
  });
});
