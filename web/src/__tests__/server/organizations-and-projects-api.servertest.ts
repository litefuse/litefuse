/** @jest-environment node */

/**
 * Characterisation tests for the "organizations-and-projects" clean-room batch
 * (spec: docs/ee-independence/02-organizations-and-projects/spec.md).
 *
 * Author: Select DB — the party that has read the original implementations and
 * therefore owns the specification, the tests and the gates. The implementation
 * is written by Zhang Mo, who never sees the originals; the role convention is
 * documented in docs/ee-independence/README.md.
 *
 * Everything here is black box: HTTP calls through `makeAPICall` /
 * `makeZodVerifiedAPICall` (server on http://localhost:3000) plus assertions on
 * the HTTP response and on Postgres state through `prisma`. Two behaviours are
 * only observable outside the HTTP surface and are asserted directly:
 *   - the data-retention 403 branch of createProject/updateProject is
 *     unreachable through any plan that can pass the admin-api guard (spec
 *     §J.4), so those exported functions are called directly;
 *   - the ProjectDeleteQueue / DorisSplitTableProvisioningQueue side effects are
 *     read out of Redis with the key layout of the pinned BullMQ version
 *     (`bull:<queue>:<jobId>`). BullMQ Queue instances are deliberately NOT
 *     constructed inside the jest process: their connections keep jest from
 *     exiting.
 *
 * Cases implemented in this file (spec §H `new` cases):
 *   H2, H3, H4, H6, H11, H16, H19, H20, H21, H22, H23, H28, H29, H30, H31,
 *   H35, H37, H38, H48, H49(score configs), H58, H59, H60, H61, H62, H63, H64,
 *   H76, H77, H78, H83, H84, H86(GET/POST), H87, H88, H92, H99, H100, H105,
 *   H112; plus the two direct-module 403 retention cases (spec §C.2 step 4 /
 *   §C.3, unreachable over HTTP).
 *
 * Mapped to already-existing suites (NOT re-implemented here; kept green):
 *   organizations-api.servertest.ts -> H1, H5, H7, H8, H9, H10, H12, H13, H14,
 *                                     H15, H17, H18, H24, H25, H26, H27, H32,
 *                                     H33, H34, H36, H40..H47, H89(list shape),
 *                                     H90, H91, H93..H98, H106
 *   projects-api.servertest.ts     -> H50..H57, H66..H75, H79(basic), H80, H81,
 *                                     H82, H107..H111
 * The existing suites are re-run by the batch gate; the mapped cases whose
 * assertions are strengthened here are H5, H6, H8, H9, H34, H74, H79, H89, H105,
 * H106 and the H86/H87/H88 method-ordering cases.
 *
 * ---------------------------------------------------------------------------
 * SPECIFIED BUT NOT ASSERTABLE (with reason) -- see the batch report for detail
 * ---------------------------------------------------------------------------
 * [H39] "Stripe cancellation failure aborts the delete -> 500, org remains".
 *   `cancelSubscriptionImmediatelyForOrganization` returns immediately when
 *   `STRIPE_SECRET_KEY` is unset, which is the case in this environment, so the
 *   failure cannot be injected over HTTP. Omitted.
 * [H65] "Doris control-row write fails -> project rolled back, 500". Requires
 *   fault injection into `provisionSplitForNewProject`, which only exists inside
 *   the server process. Omitted rather than mocked.
 * [H85] "ProjectDeleteQueue.getInstance() === null -> 500 after the soft delete
 *   / key delete / audit row". Requires fault injection into a shared Redis
 *   singleton inside the server process. Omitted.
 * [H101] "organizationId / apiKeyId not a string -> 400 Invalid organization
 *   ID[ or API key ID]". Measured with this Next.js version: for a dynamic
 *   segment the path parameter wins and a repeated `?organizationId=` query
 *   parameter does not surface as an array --
 *   `GET /api/admin/organizations/abc?organizationId=xyz&organizationId=def`
 *   -> 404 `{"error":"Organization not found"}` and
 *   `DELETE /api/admin/organizations/abc/apiKeys/def?apiKeyId=1&apiKeyId=2`
 *   -> 404 `{"error":"Organization not found"}`. The 400 branch is unreachable
 *   over HTTP. Omitted (same finding as C93 of the keys-and-memberships batch).
 * [H102, H103, H104] "instance without admin-api entitlement -> 403", "cloud
 *   region -> 403 Not accessible on Litefuse Cloud", "ADMIN_API_KEY unset ->
 *   403". All three need the web server restarted with a different environment;
 *   the batch gate runs a single server instance. Omitted.
 *
 * ---------------------------------------------------------------------------
 * HISTORICAL FINDING -- FOUND HERE, FIXED IN d6a6567, NOW PINNED BY H38
 * ---------------------------------------------------------------------------
 * [H38] originally contradicted the implementation: deleteOrganization called
 *   `invalidateCachedOrgApiKeys(orgId)` AFTER `prisma.organization.delete`, and
 *   that helper re-reads `api_keys` from Postgres, so the cascade had already
 *   removed every key it would have evicted. A warm cache entry therefore kept
 *   authenticating a deleted organization's key for the remaining TTL (300s):
 *   warm GET -> 200, DELETE -> 200, same key -> 200 while the apiKey row was
 *   already null. Commit d6a6567 moved the invalidation before the delete
 *   (spec §B.5 steps 4-5, §K.1); the H38 test below asserts the fixed sequence
 *   (warm 200 -> delete 200 -> same key 401, with the row confirmed gone).
 */

import {
  makeAPICall,
  makeZodVerifiedAPICall,
} from "@/src/__tests__/test-utils";
import { prisma } from "@langfuse/shared/src/db";
import {
  QueueName,
  createAndAddApiKeysToDb,
  createBasicAuthHeader,
  redis,
  type ApiAccessScope,
} from "@langfuse/shared/src/server";
import { createProject } from "@/src/features/enterprise/projects/createProject";
import { updateProject } from "@/src/features/enterprise/projects/updateProject";
import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { z } from "zod/v4";

// The first HTTP call of a run may still compile a route on the dev server.
jest.setTimeout(120_000);

const adminAuth = () => `Bearer ${process.env.ADMIN_API_KEY}`;
const basic = (publicKey: string, secretKey: string) =>
  createBasicAuthHeader(publicKey, secretKey);
const unique = () => randomUUID().slice(0, 8);
const baseUrl = (url: string) =>
  `http://localhost:3000${url.startsWith("/") ? url : `/${url}`}`;

/** Request that genuinely carries no Authorization header (makeAPICall cannot). */
const unauthed = (method: string, url: string) =>
  fetch(baseUrl(url), {
    method,
    headers: { Accept: "application/json" },
  });

/**
 * Read a BullMQ job's `data` blob without instantiating a BullMQ Queue in this
 * process (see the file header). The queue prefix is BullMQ's default `bull`
 * unless REDIS_KEY_PREFIX is set.
 */
const bullPrefix = () => process.env.REDIS_KEY_PREFIX || "bull";
const queueKey = (queue: QueueName, suffix: string) =>
  `${bullPrefix()}:${queue}:${suffix}`;

async function findProjectDeleteJobs(projectId: string) {
  const queue = QueueName.ProjectDelete;
  const jobIds = [
    ...(await redis!.zrange(queueKey(queue, "delayed"), 0, -1)),
    ...(await redis!.lrange(queueKey(queue, "wait"), 0, -1)),
  ];
  const jobs: Array<Record<string, unknown>> = [];
  for (const jobId of jobIds) {
    const data = await redis!.hget(queueKey(queue, jobId), "data");
    if (!data) continue;
    const parsed = JSON.parse(data);
    if (parsed?.payload?.projectId === projectId) jobs.push(parsed);
  }
  return jobs;
}

type ResCalls = { status?: number; body?: unknown };
const captureRes = () => {
  const calls: ResCalls = {};
  const res: Record<string, unknown> = {};
  res.status = (code: number) => {
    calls.status = code;
    return res;
  };
  res.json = (body: unknown) => {
    calls.body = body;
    return res;
  };
  return { res: res as unknown as NextApiResponse, calls };
};

/** Plan without the data-retention entitlement; only reachable directly. */
const ossScope = {
  projectId: null,
  accessLevel: "organization",
  orgId: "000000000000000000000000",
  plan: "oss",
  rateLimitOverrides: [],
  apiKeyId: "oss-scope-key",
  publicKey: "pk-lf-oss-scope",
  isIngestionSuspended: false,
} as unknown as ApiAccessScope;

const OrganizationProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  projects: z.array(OrganizationProjectSchema),
});

const OrganizationsListSchema = z.object({
  organizations: z.array(OrganizationSchema),
});

const ProjectListSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      metadata: z.record(z.string(), z.unknown()).nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});

describe("organizations-and-projects API characterisation", () => {
  if (!process.env.ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY must be set for the instance-admin cases");
  }

  // Own fixtures, unique names, cleaned up in afterAll. Nothing here depends on
  // rows that happen to exist in the test database.
  const trackedOrgIds: string[] = [];

  let orgMeta: { id: string };
  let projMetaLive: { id: string; name: string };
  let orgNullMeta: { id: string };
  let orgSoftOnly: { id: string; name: string };
  let orgWithLiveProject: { id: string };
  let orgForUpdate: { id: string };
  let orgKeys: { id: string };
  let orgKeysFirst: { id: string; publicKey: string; secretKey: string };
  let orgKeysSecond: { id: string; publicKey: string; secretKey: string };
  let orgKeyAudit: { id: string };

  let pOrg: { id: string };
  let pOrgKey: { id: string; publicKey: string; secretKey: string };
  let pProject: { id: string; name: string };
  let pProjectKey: { id: string; publicKey: string; secretKey: string };
  let pListOrg: { id: string };
  let pListKey: { id: string; publicKey: string; secretKey: string };
  let pListProjectIds: string[];

  const createOrg = async (data: {
    name: string;
    metadata?: unknown;
    cloudPlan?: "Pro";
  }) => {
    const org = await prisma.organization.create({
      data: {
        name: data.name,
        ...(data.metadata !== undefined
          ? { metadata: data.metadata as never }
          : {}),
        ...(data.cloudPlan ? { cloudConfig: { plan: data.cloudPlan } } : {}),
      },
    });
    trackedOrgIds.push(org.id);
    return org;
  };

  const createProjectRow = async (data: {
    name: string;
    orgId: string;
    metadata?: unknown;
    deletedAt?: Date;
  }) => {
    const project = await prisma.project.create({
      data: {
        name: data.name,
        orgId: data.orgId,
        ...(data.metadata !== undefined
          ? { metadata: data.metadata as never }
          : {}),
        ...(data.deletedAt ? { deletedAt: data.deletedAt } : {}),
      },
    });
    return project;
  };

  const newOrgKey = async (orgId: string, note?: string) => {
    const key = await createAndAddApiKeysToDb({
      prisma,
      entityId: orgId,
      scope: "ORGANIZATION",
      ...(note ? { note } : {}),
    });
    return key as { id: string; publicKey: string; secretKey: string };
  };

  const newProjectKey = async (projectId: string, note?: string) => {
    const key = await createAndAddApiKeysToDb({
      prisma,
      entityId: projectId,
      scope: "PROJECT",
      ...(note ? { note } : {}),
    });
    return key as { id: string; publicKey: string; secretKey: string };
  };

  const pOrgAuth = () => basic(pOrgKey.publicKey, pOrgKey.secretKey);

  beforeAll(async () => {
    // ---- organization fixtures -------------------------------------------
    orgMeta = await createOrg({
      name: `C2b Org Meta ${unique()}`,
      metadata: { tier: "testing", users: 5 },
    });
    projMetaLive = await createProjectRow({
      name: `C2b Meta Live ${unique()}`,
      orgId: orgMeta.id,
      metadata: { environment: "test" },
    });
    await createProjectRow({
      name: `C2b Meta Gone ${unique()}`,
      orgId: orgMeta.id,
      deletedAt: new Date(),
    });

    orgNullMeta = await createOrg({ name: `C2b Org Null ${unique()}` });

    orgSoftOnly = await createOrg({ name: `C2b Org Soft ${unique()}` });
    await createProjectRow({
      name: `C2b Soft Only ${unique()}`,
      orgId: orgSoftOnly.id,
      deletedAt: new Date(),
    });

    orgWithLiveProject = await createOrg({
      name: `C2b Org Live ${unique()}`,
    });
    await createProjectRow({
      name: `C2b Live Child ${unique()}`,
      orgId: orgWithLiveProject.id,
    });

    orgForUpdate = await createOrg({
      name: `C2b Org Update ${unique()}`,
      metadata: { a: 1 },
    });

    orgKeys = await createOrg({ name: `C2b Org Keys ${unique()}` });
    orgKeysFirst = await newOrgKey(orgKeys.id, "C2b first key");
    orgKeysSecond = await newOrgKey(orgKeys.id, "C2b second key");

    orgKeyAudit = await createOrg({ name: `C2b Org Key Audit ${unique()}` });

    // ---- project fixtures -------------------------------------------------
    pOrg = await createOrg({
      name: `C2b Project Org ${unique()}`,
      cloudPlan: "Pro",
    });
    pOrgKey = await newOrgKey(pOrg.id, "C2b org key");
    pProject = await createProjectRow({
      name: `C2b Fixture Project ${unique()}`,
      orgId: pOrg.id,
    });
    pProjectKey = await newProjectKey(pProject.id, "C2b project key");

    pListOrg = await createOrg({
      name: `C2b List Org ${unique()}`,
      cloudPlan: "Pro",
    });
    pListKey = await newOrgKey(pListOrg.id, "C2b list org key");
    const listNames = Array.from(
      { length: 55 },
      (_, i) => `C2b List Project ${i} ${unique()}`,
    );
    await prisma.project.createMany({
      data: listNames.map((name) => ({ name, orgId: pListOrg.id })),
    });
    pListProjectIds = (
      await prisma.project.findMany({
        where: { orgId: pListOrg.id },
        select: { id: true },
      })
    ).map((p) => p.id);
  });

  afterAll(async () => {
    const orgIds = [...new Set(trackedOrgIds)];
    const projectIds = (
      await prisma.project.findMany({
        where: { orgId: { in: orgIds } },
        select: { id: true },
      })
    ).map((p) => p.id);

    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ orgId: { in: orgIds } }, { projectId: { in: projectIds } }],
      },
    });
    await prisma.apiKey.deleteMany({
      where: {
        OR: [{ orgId: { in: orgIds } }, { projectId: { in: projectIds } }],
      },
    });
    await prisma.projectMembership.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await prisma.organizationMembership.deleteMany({
      where: { orgId: { in: orgIds } },
    });
    await prisma.scoreConfig.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await prisma.dorisProjectTableSplit.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  });

  // =====================================================================
  // §B.1/§B.2 organization list & get
  // =====================================================================
  describe("admin organization list and get", () => {
    // H2 + H4 (H1/H3 are covered by the existing suite; strengthened here)
    it("H2/H4/H3 lists NULL metadata as {} and only live projects", async () => {
      const { body, status } = await makeZodVerifiedAPICall(
        OrganizationsListSchema,
        "GET",
        "/api/admin/organizations",
        undefined,
        adminAuth(),
        200,
      );
      expect(status).toBe(200);

      const nullMeta = body.organizations.find((o) => o.id === orgNullMeta.id);
      expect(nullMeta).toBeDefined();
      expect(nullMeta!.metadata).toEqual({});
      expect(nullMeta!.projects).toEqual([]);

      const withMeta = body.organizations.find((o) => o.id === orgMeta.id);
      expect(withMeta).toBeDefined();
      expect(withMeta!.metadata).toEqual({ tier: "testing", users: 5 });
      expect(withMeta!.projects.map((p) => p.id)).toEqual([projMetaLive.id]);
    });

    // H8 (strengthens the mapped "get a specific organization by ID")
    it("H8 returns the documented organization projection with live projects", async () => {
      const res = await makeAPICall(
        "GET",
        `/api/admin/organizations/${orgMeta.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(200);
      const body = res.body as any;
      // No updatedAt, no cloudConfig, and nothing else.
      expect(Object.keys(body).sort()).toEqual(
        ["createdAt", "id", "metadata", "name", "projects"].sort(),
      );
      expect(body.id).toBe(orgMeta.id);
      expect(body.metadata).toEqual({ tier: "testing", users: 5 });
      expect(body.projects).toHaveLength(1);
      expect(Object.keys(body.projects[0]).sort()).toEqual(
        ["createdAt", "id", "metadata", "name", "updatedAt"].sort(),
      );
      expect(body.projects[0]).toMatchObject({
        id: projMetaLive.id,
        name: projMetaLive.name,
        metadata: { environment: "test" },
      });
      expect(body.projects[0].createdAt).toEqual(expect.any(String));
      expect(body.projects[0].updatedAt).toEqual(expect.any(String));
    });

    // H9 (strengthens the mapped "should not return soft-deleted projects")
    it("H9 returns an empty projects array when every project is soft-deleted", async () => {
      const res = await makeAPICall(
        "GET",
        `/api/admin/organizations/${orgSoftOnly.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(200);
      expect((res.body as any).projects).toEqual([]);
    });

    // H11
    it("H11 normalises NULL metadata to {} on a single organization", async () => {
      const res = await makeAPICall(
        "GET",
        `/api/admin/organizations/${orgNullMeta.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(200);
      expect((res.body as any).metadata).toEqual({});
    });

    // H6 + H105
    it("H6/H105 rejects a well-formed but wrong Bearer token with 401 and the exact error", async () => {
      const res = await makeAPICall(
        "GET",
        "/api/admin/organizations",
        undefined,
        "Bearer invalid-admin-key",
      );
      expect(res.status).toBe(401);
      expect((res.body as any).error).toBe("Unauthorized: Invalid token");
    });

    // H5 (strengthens the mapped no-header cases, which send a Basic fallback)
    it("H5 rejects a request with no Authorization header at all", async () => {
      const res = await unauthed("GET", "/api/admin/organizations");
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe(
        "Unauthorized: authorization header is missing",
      );
    });

    // H106
    it("H106 rejects a Basic Authorization scheme with 401", async () => {
      const res = await makeAPICall(
        "GET",
        "/api/admin/organizations",
        undefined,
        basic("pk-lf-1234567890", "sk-lf-1234567890"),
      );
      expect(res.status).toBe(401);
      expect((res.body as any).error).toBe("Unauthorized: Invalid token");
    });
  });

  // =====================================================================
  // §B.3 createOrganization
  // =====================================================================
  describe("createOrganization", () => {
    // H16
    it("H16 rejects an HTML-containing name with 400 Invalid request body", async () => {
      const res = await makeAPICall(
        "POST",
        "/api/admin/organizations",
        { name: `<b>x</b>${unique()}` },
        adminAuth(),
      );
      expect(res.status).toBe(400);
      const body = res.body as any;
      expect(body.error).toBe("Invalid request body");
      expect(body.details).toBeDefined();
    });

    // H19
    it("H19 accepts metadata encoded as a JSON string and stores the parsed object", async () => {
      const name = `C2b Create JsonString ${unique()}`;
      const res = await makeAPICall(
        "POST",
        "/api/admin/organizations",
        { name, metadata: '{"a":1}' },
        adminAuth(),
      );
      expect(res.status).toBe(201);
      const body = res.body as any;
      trackedOrgIds.push(body.id);
      expect(Object.keys(body).sort()).toEqual(
        ["createdAt", "id", "metadata", "name", "projects"].sort(),
      );
      expect(body.metadata).toEqual({ a: 1 });
      expect(body.projects).toEqual([]);

      const row = await prisma.organization.findUnique({
        where: { id: body.id },
      });
      expect(row?.metadata).toEqual({ a: 1 });
    });

    // H20
    it("H20 rejects undecodable metadata with the exact error prefix", async () => {
      const res = await makeAPICall(
        "POST",
        "/api/admin/organizations",
        { name: `C2b Create BadJson ${unique()}`, metadata: "{not json" },
        adminAuth(),
      );
      expect(res.status).toBe(400);
      expect((res.body as any).error).toMatch(
        /^Invalid metadata\. Should be a valid JSON object:/,
      );
    });

    // H21
    it("H21 rejects array/null/number metadata with the exact error", async () => {
      for (const metadata of [[1], null, 5]) {
        const res = await makeAPICall(
          "POST",
          "/api/admin/organizations",
          { name: `C2b Create BadMeta ${unique()}`, metadata },
          adminAuth(),
        );
        expect(res.status).toBe(400);
        expect((res.body as any).error).toBe(
          "Invalid metadata. Should be a valid JSON object.",
        );
      }
    });

    // H22 + H23
    it("H22/H23 writes a create audit row and no companion rows", async () => {
      const name = `C2b Create Audit ${unique()}`;
      const res = await makeAPICall(
        "POST",
        "/api/admin/organizations",
        { name, metadata: { tier: "testing", users: 5 } },
        adminAuth(),
      );
      expect(res.status).toBe(201);
      const id = (res.body as any).id as string;
      trackedOrgIds.push(id);

      const log = await prisma.auditLog.findFirst({
        where: { orgId: id, resourceType: "organization", action: "create" },
      });
      expect(log).not.toBeNull();
      expect(log!.type).toBe("API_KEY");
      expect(log!.apiKeyId).toBe("admin-api");
      expect(log!.projectId).toBeNull();
      expect(log!.userId).toBeNull();
      expect(log!.resourceId).toBe(id);
      expect(log!.before).toBeNull();
      const after = JSON.parse(log!.after!);
      expect(after.id).toBe(id);
      expect(after.name).toBe(name);
      expect(after.projects).toEqual([]);

      // No default members / projects / keys are created alongside.
      expect(
        await prisma.organizationMembership.count({ where: { orgId: id } }),
      ).toBe(0);
      expect(await prisma.project.count({ where: { orgId: id } })).toBe(0);
      expect(await prisma.apiKey.count({ where: { orgId: id } })).toBe(0);
    });

    // H16/H20/H21 must not have created anything.
    it("H16/H20/H21 created no organization rows", async () => {
      const rows = await prisma.organization.findMany({
        where: {
          OR: [
            { name: { startsWith: "C2b Create Bad" } },
            { name: { startsWith: "<b>x</b>" } },
          ],
        },
      });
      expect(rows).toHaveLength(0);
    });
  });

  // =====================================================================
  // §B.4 updateOrganization
  // =====================================================================
  describe("updateOrganization", () => {
    // H28
    it("H28 validates the body before the existence check (400, not 404)", async () => {
      const res = await makeAPICall(
        "PUT",
        `/api/admin/organizations/${randomUUID()}`,
        { name: "A" },
        adminAuth(),
      );
      expect(res.status).toBe(400);
      const body = res.body as any;
      expect(body.error).toBe("Invalid request body");
      expect(body.details).toBeDefined();
    });

    // H29
    it("H29 keeps the stored metadata when the body omits it", async () => {
      const name = `C2b Update Omit ${unique()}`;
      const res = await makeAPICall(
        "PUT",
        `/api/admin/organizations/${orgForUpdate.id}`,
        { name },
        adminAuth(),
      );
      expect(res.status).toBe(200);
      expect((res.body as any).name).toBe(name);
      expect((res.body as any).metadata).toEqual({ a: 1 });

      const row = await prisma.organization.findUnique({
        where: { id: orgForUpdate.id },
      });
      expect(row?.name).toBe(name);
      expect(row?.metadata).toEqual({ a: 1 });
    });

    // H30
    it("H30 replaces metadata sent as a JSON string", async () => {
      const name = `C2b Update JsonString ${unique()}`;
      const res = await makeAPICall(
        "PUT",
        `/api/admin/organizations/${orgForUpdate.id}`,
        { name, metadata: '{"b":2}' },
        adminAuth(),
      );
      expect(res.status).toBe(200);
      expect((res.body as any).metadata).toEqual({ b: 2 });

      const row = await prisma.organization.findUnique({
        where: { id: orgForUpdate.id },
      });
      expect(row?.name).toBe(name);
      expect(row?.metadata).toEqual({ b: 2 });
    });

    // H31
    it("H31 writes no audit log row", async () => {
      const before = await prisma.auditLog.count({
        where: { orgId: orgForUpdate.id },
      });
      const res = await makeAPICall(
        "PUT",
        `/api/admin/organizations/${orgForUpdate.id}`,
        { name: `C2b Update NoAudit ${unique()}`, metadata: { c: 3 } },
        adminAuth(),
      );
      expect(res.status).toBe(200);
      const after = await prisma.auditLog.count({
        where: { orgId: orgForUpdate.id },
      });
      expect(after).toBe(before);
    });
  });

  // =====================================================================
  // §B.5 deleteOrganization
  // =====================================================================
  describe("deleteOrganization", () => {
    // H32 + H37
    it("H32/H37 hard-deletes an empty organization and writes the delete audit row", async () => {
      const org = await createOrg({ name: `C2b Delete Empty ${unique()}` });
      const res = await makeAPICall(
        "DELETE",
        `/api/admin/organizations/${org.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(
        await prisma.organization.findUnique({ where: { id: org.id } }),
      ).toBeNull();

      const log = await prisma.auditLog.findFirst({
        where: {
          orgId: org.id,
          resourceType: "organization",
          action: "delete",
        },
      });
      expect(log).not.toBeNull();
      expect(log!.type).toBe("API_KEY");
      expect(log!.apiKeyId).toBe("admin-api");
      expect(log!.projectId).toBeNull();
      expect(log!.userId).toBeNull();
      expect(log!.resourceId).toBe(org.id);
      expect(log!.after).toBeNull();
      expect(JSON.parse(log!.before!).id).toBe(org.id);
    });

    // H34 (strengthens the mapped 400 case with the exact message)
    it("H34 refuses to delete an organization that still has a live project", async () => {
      const res = await makeAPICall(
        "DELETE",
        `/api/admin/organizations/${orgWithLiveProject.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: "Organization cannot be deleted while it still has projects",
        message:
          "Please delete or transfer all projects before deleting the organization.",
      });
      expect(
        await prisma.organization.findUnique({
          where: { id: orgWithLiveProject.id },
        }),
      ).not.toBeNull();
    });

    // H35
    it("H35 refuses to delete an organization whose only projects are soft-deleted", async () => {
      const res = await makeAPICall(
        "DELETE",
        `/api/admin/organizations/${orgSoftOnly.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: "Organization cannot be deleted while it still has projects",
        message:
          "Deletion of your projects is still being processed, please try deleting the organization later",
      });
      expect(
        await prisma.organization.findUnique({
          where: { id: orgSoftOnly.id },
        }),
      ).not.toBeNull();
    });

    // H38
    it("H38 invalidates a warm cached organization key so it stops authenticating after the delete", async () => {
      const org = await createOrg({
        name: `C2b Delete Cache ${unique()}`,
        cloudPlan: "Pro",
      });
      const key = await newOrgKey(org.id, "C2b cache key");
      const auth = basic(key.publicKey, key.secretKey);

      // Warm the Redis auth cache with a successful call. Without this the 401
      // below would only prove that the cascaded row is gone.
      const warm = await makeAPICall(
        "GET",
        "/api/public/organizations/projects",
        undefined,
        auth,
      );
      expect(warm.status).toBe(200);

      const del = await makeAPICall(
        "DELETE",
        `/api/admin/organizations/${org.id}`,
        undefined,
        adminAuth(),
      );
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ success: true });

      // The key row really cascaded away, so the 401 is attributable to the
      // cache having been invalidated rather than to a missing row.
      expect(
        await prisma.apiKey.findUnique({ where: { id: key.id } }),
      ).toBeNull();

      const after = await makeAPICall(
        "GET",
        "/api/public/organizations/projects",
        undefined,
        auth,
      );
      expect(after.status).toBe(401);
      expect((after.body as any).error).toContain("Invalid credentials");
    });
  });

  // =====================================================================
  // §D.3/§D.4 admin apiKeys route wrappers
  // =====================================================================
  describe("admin organization apiKeys route wrappers", () => {
    // H89 (strengthens the mapped list case: exact projection, no secrets)
    it("H89 lists the organization's ORGANIZATION-scope keys with exactly seven fields", async () => {
      const res = await makeAPICall(
        "GET",
        `/api/admin/organizations/${orgKeys.id}/apiKeys`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(200);
      const apiKeys = (res.body as any).apiKeys as any[];
      expect(apiKeys).toHaveLength(2);
      // Ordered by createdAt ascending; both fixture keys are present.
      expect(apiKeys.map((k) => k.note)).toEqual(
        expect.arrayContaining(["C2b first key", "C2b second key"]),
      );
      for (let i = 0; i < apiKeys.length - 1; i++) {
        expect(new Date(apiKeys[i].createdAt).getTime()).toBeLessThanOrEqual(
          new Date(apiKeys[i + 1].createdAt).getTime(),
        );
      }
      for (const key of apiKeys) {
        expect(Object.keys(key).sort()).toEqual(
          [
            "createdAt",
            "displaySecretKey",
            "expiresAt",
            "id",
            "lastUsedAt",
            "note",
            "publicKey",
          ].sort(),
        );
        expect(key).not.toHaveProperty("secretKey");
        expect(key).not.toHaveProperty("hashedSecretKey");
      }
    });

    // H92
    it("H92 writes a create audit row for a key created through the admin route", async () => {
      const res = await makeAPICall(
        "POST",
        `/api/admin/organizations/${orgKeyAudit.id}/apiKeys`,
        { note: "C2b audited key" },
        adminAuth(),
      );
      expect(res.status).toBe(201);
      const keyId = (res.body as any).id as string;

      const log = await prisma.auditLog.findFirst({
        where: { orgId: orgKeyAudit.id, resourceId: keyId, action: "create" },
      });
      expect(log).not.toBeNull();
      expect(log!.type).toBe("API_KEY");
      expect(log!.apiKeyId).toBe("admin-api");
      expect(log!.resourceType).toBe("apiKey");
      expect(log!.projectId).toBeNull();
    });

    // H99
    it("H99 returns 405 for PATCH on the organization apiKeys collection", async () => {
      const res = await makeAPICall(
        "PATCH",
        `/api/admin/organizations/${orgKeys.id}/apiKeys`,
        {},
        adminAuth(),
      );
      expect(res.status).toBe(405);
      expect((res.body as any).error).toBe(
        "Method not allowed. Allowed methods: GET, POST",
      );
    });

    // H100
    it("H100 returns 405 listing only DELETE for GET on a key resource", async () => {
      const res = await makeAPICall(
        "GET",
        `/api/admin/organizations/${orgKeys.id}/apiKeys/${orgKeysFirst.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(405);
      expect((res.body as any).error).toBe(
        "Method not allowed. Allowed methods: DELETE",
      );
    });
  });

  // =====================================================================
  // §C.1 listProjects
  // =====================================================================
  describe("listProjects", () => {
    // H48
    it("H48 returns every live project of the organization without pagination", async () => {
      const { body, status } = await makeZodVerifiedAPICall(
        ProjectListSchema,
        "GET",
        "/api/public/organizations/projects",
        undefined,
        basic(pListKey.publicKey, pListKey.secretKey),
        200,
      );
      expect(status).toBe(200);
      expect(body.projects).toHaveLength(55);
      const returned = body.projects.map((p) => p.id);
      for (const id of pListProjectIds) {
        expect(returned).toContain(id);
      }
    });
  });

  // =====================================================================
  // §C.2 createProject
  // =====================================================================
  describe("createProject", () => {
    // H49 (the score-config half is new)
    it("H49 creates the project with five default score configs and a Doris control row", async () => {
      const name = `C2b Create Project ${unique()}`;
      const metadata = { plan: "pro", features: ["all"] };
      const res = await makeAPICall(
        "POST",
        "/api/public/projects",
        { name, metadata },
        pOrgAuth(),
      );
      expect(res.status).toBe(201);
      const body = res.body as any;
      expect(Object.keys(body).sort()).toEqual(["id", "metadata", "name"]);
      expect(body.name).toBe(name);
      expect(body.metadata).toEqual(metadata);

      const project = await prisma.project.findUnique({
        where: { id: body.id },
      });
      expect(project).not.toBeNull();
      expect(project!.orgId).toBe(pOrg.id);
      expect(project!.metadata).toEqual(metadata);

      const configs = await prisma.scoreConfig.findMany({
        where: { projectId: body.id },
        orderBy: { name: "asc" },
      });
      expect(configs.map((c) => c.name)).toEqual([
        "accuracy",
        "helpfulness",
        "is_correct",
        "relevance",
        "toxicity",
      ]);
      const byName = new Map(configs.map((c) => [c.name, c]));
      expect(byName.get("is_correct")).toMatchObject({
        dataType: "BOOLEAN",
        categories: [
          { label: "True", value: 1 },
          { label: "False", value: 0 },
        ],
        description: "Whether the output is correct.",
      });
      for (const [configName, description] of [
        ["accuracy", "Accuracy score from 0 to 1."],
        ["relevance", "Relevance score from 0 to 1."],
        ["helpfulness", "Helpfulness score from 0 to 1."],
        ["toxicity", "Toxicity score from 0 to 1."],
      ] as const) {
        expect(byName.get(configName)).toMatchObject({
          dataType: "NUMERIC",
          minValue: 0,
          maxValue: 1,
          description,
        });
      }

      const split = await prisma.dorisProjectTableSplit.findUnique({
        where: { projectId: body.id },
      });
      expect(split).not.toBeNull();
    });

    // H58
    it("H58 allows reusing the name of a soft-deleted project", async () => {
      const name = `C2b Soft Duplicate ${unique()}`;
      await createProjectRow({
        name,
        orgId: pOrg.id,
        deletedAt: new Date(),
      });
      const res = await makeAPICall(
        "POST",
        "/api/public/projects",
        { name },
        pOrgAuth(),
      );
      expect(res.status).toBe(201);
      const live = await prisma.project.findMany({
        where: { orgId: pOrg.id, name, deletedAt: null },
      });
      expect(live).toHaveLength(1);
    });

    // H59
    it("H59 accepts metadata encoded as a JSON string", async () => {
      const name = `C2b Create JsonString P ${unique()}`;
      const res = await makeAPICall(
        "POST",
        "/api/public/projects",
        { name, metadata: '{"a":1}' },
        pOrgAuth(),
      );
      expect(res.status).toBe(201);
      expect((res.body as any).metadata).toEqual({ a: 1 });
      const row = await prisma.project.findUnique({
        where: { id: (res.body as any).id },
      });
      expect(row?.metadata).toEqual({ a: 1 });
    });

    // H60
    it("H60 rejects undecodable metadata with the exact error prefix", async () => {
      const res = await makeAPICall(
        "POST",
        "/api/public/projects",
        { name: `C2b Create BadJson P ${unique()}`, metadata: "{bad" },
        pOrgAuth(),
      );
      expect(res.status).toBe(400);
      expect((res.body as any).message).toMatch(
        /^Metadata is not decodable JSON:/,
      );
    });

    // H61
    it("H61 rejects array/null/number metadata with the exact error", async () => {
      for (const metadata of [[], null, 1]) {
        const res = await makeAPICall(
          "POST",
          "/api/public/projects",
          { name: `C2b Create BadMeta P ${unique()}`, metadata },
          pOrgAuth(),
        );
        expect(res.status).toBe(400);
        expect((res.body as any).message).toBe(
          "Metadata must be a JSON object.",
        );
      }
    });

    // H62
    it("H62 writes no audit log row for a successful create", async () => {
      const before = await prisma.auditLog.count({
        where: { orgId: pOrg.id },
      });
      const res = await makeAPICall(
        "POST",
        "/api/public/projects",
        { name: `C2b Create NoAudit ${unique()}` },
        pOrgAuth(),
      );
      expect(res.status).toBe(201);
      const after = await prisma.auditLog.count({ where: { orgId: pOrg.id } });
      expect(after).toBe(before);
    });

    // H63 -- pins the coerced-vs-raw retention oddity (spec §J.3)
    it("H63 accepts a numeric-string retention at validation and then fails with 500", async () => {
      const name = `C2b Retention String ${unique()}`;
      const res = await makeAPICall(
        "POST",
        "/api/public/projects",
        { name, retention: "30" },
        pOrgAuth(),
      );
      expect(res.status).toBe(500);
      expect((res.body as any).message).toBe("Internal server error");
      expect(
        await prisma.project.findFirst({ where: { orgId: pOrg.id, name } }),
      ).toBeNull();
    });

    // H64
    it("H64 stores null retention and omits retentionDays", async () => {
      const name = `C2b Retention Null ${unique()}`;
      const res = await makeAPICall(
        "POST",
        "/api/public/projects",
        { name, retention: null },
        pOrgAuth(),
      );
      expect(res.status).toBe(201);
      const body = res.body as any;
      expect(body).not.toHaveProperty("retentionDays");
      const row = await prisma.project.findUnique({ where: { id: body.id } });
      expect(row?.retentionDays).toBeNull();
    });

    // Spec §J.4 -- the branch is unreachable through the admin-api guard.
    it("createProject returns 403 for a positive retention without the data-retention entitlement", async () => {
      const { res, calls } = captureRes();
      await createProject(
        {
          body: { name: "C2b Direct Retention", retention: 30 },
        } as unknown as NextApiRequest,
        res,
        ossScope,
      );
      expect(calls.status).toBe(403);
      expect(calls.body).toEqual({
        message:
          "A retention period above zero requires the data-retention entitlement.",
      });
    });

    // H112
    it("H112 rejects unauthorized create requests without creating anything", async () => {
      const invalidName = `C2b Unauthorized Invalid ${unique()}`;
      const invalid = await makeAPICall(
        "POST",
        "/api/public/projects",
        { name: invalidName },
        basic("pk-lf-invalid", "sk-lf-invalid"),
      );
      expect(invalid.status).toBe(401);
      // Exact text is owned by ApiAuthService (out of batch); spec H.55 pins the
      // substring.
      expect((invalid.body as any).error).toContain("Invalid credentials");

      const projectKeyName = `C2b Unauthorized ProjectKey ${unique()}`;
      const withProjectKey = await makeAPICall(
        "POST",
        "/api/public/projects",
        { name: projectKeyName },
        basic(pProjectKey.publicKey, pProjectKey.secretKey),
      );
      expect(withProjectKey.status).toBe(403);
      expect((withProjectKey.body as any).error).toBe(
        "Invalid API key. Organization-scoped API key required for this operation.",
      );

      const rows = await prisma.project.findMany({
        where: { orgId: pOrg.id, name: { in: [invalidName, projectKeyName] } },
      });
      expect(rows).toHaveLength(0);
    });
  });

  // =====================================================================
  // §C.3 updateProject
  // =====================================================================
  describe("updateProject", () => {
    // H77
    it("H77 rejects array metadata with the exact error", async () => {
      const res = await makeAPICall(
        "PUT",
        `/api/public/projects/${pProject.id}`,
        { name: pProject.name, metadata: [] },
        pOrgAuth(),
      );
      expect(res.status).toBe(400);
      expect((res.body as any).message).toBe("Metadata must be a JSON object.");
    });

    // H78
    it("H78 writes no audit log row for a successful update", async () => {
      const before = await prisma.auditLog.count({
        where: { projectId: pProject.id },
      });
      const res = await makeAPICall(
        "PUT",
        `/api/public/projects/${pProject.id}`,
        { name: `C2b Updated ${unique()}` },
        pOrgAuth(),
      );
      expect(res.status).toBe(200);
      const after = await prisma.auditLog.count({
        where: { projectId: pProject.id },
      });
      expect(after).toBe(before);
    });

    // H76 -- jobId === projectId on the Doris provisioning queue.
    it("H76 enqueues a Doris TTL re-provisioning job when retention is sent", async () => {
      const project = await createProjectRow({
        name: `C2b Retention Reprove ${unique()}`,
        orgId: pOrg.id,
      });
      const res = await makeAPICall(
        "PUT",
        `/api/public/projects/${project.id}`,
        { name: project.name, retention: 30 },
        pOrgAuth(),
      );
      expect(res.status).toBe(200);
      expect((res.body as any).retentionDays).toBe(30);

      const jobKey = queueKey(
        QueueName.DorisSplitTableProvisioningQueue,
        project.id,
      );
      expect(await redis!.exists(jobKey)).toBe(1);
      const raw = await redis!.hget(jobKey, "data");
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).payload.projectId).toBe(project.id);
    });

    // Spec §J.4 -- unreachable through the admin-api guard.
    it("updateProject returns 403 for a positive retention without the data-retention entitlement", async () => {
      const { res, calls } = captureRes();
      await updateProject(
        {
          body: { name: "C2b Direct Retention", retention: 7 },
        } as unknown as NextApiRequest,
        res,
        pProject.id,
        ossScope,
      );
      expect(calls.status).toBe(403);
      expect(calls.body).toEqual({
        message:
          "A retention period above zero requires the data-retention entitlement.",
      });
    });
  });

  // =====================================================================
  // §C.4 deleteProject
  // =====================================================================
  describe("deleteProject", () => {
    // H79 (strengthens the mapped delete case: org key survives, row survives)
    it("H79 soft-deletes the project, drops project keys and keeps the org key", async () => {
      const project = await createProjectRow({
        name: `C2b Delete Project ${unique()}`,
        orgId: pOrg.id,
      });
      const projectKey = await newProjectKey(project.id, "C2b doomed key");

      const res = await makeAPICall(
        "DELETE",
        `/api/public/projects/${project.id}`,
        undefined,
        pOrgAuth(),
      );
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        success: true,
        message:
          "The project is queued for deletion and will be removed in the background.",
      });

      const row = await prisma.project.findUnique({
        where: { id: project.id },
      });
      expect(row).not.toBeNull();
      expect(row!.deletedAt).not.toBeNull();
      expect(
        await prisma.apiKey.findUnique({ where: { id: projectKey.id } }),
      ).toBeNull();
      expect(
        await prisma.apiKey.findUnique({ where: { id: pOrgKey.id } }),
      ).not.toBeNull();
    });

    // H83
    it("H83 writes a project delete audit row attributed to the calling org key", async () => {
      const project = await createProjectRow({
        name: `C2b Delete Audit ${unique()}`,
        orgId: pOrg.id,
      });
      const res = await makeAPICall(
        "DELETE",
        `/api/public/projects/${project.id}`,
        undefined,
        pOrgAuth(),
      );
      expect(res.status).toBe(202);

      const log = await prisma.auditLog.findFirst({
        where: {
          orgId: pOrg.id,
          projectId: project.id,
          resourceId: project.id,
          action: "delete",
        },
      });
      expect(log).not.toBeNull();
      expect(log!.type).toBe("API_KEY");
      expect(log!.apiKeyId).toBe(pOrgKey.id);
      expect(log!.resourceType).toBe("project");
      expect(log!.userId).toBeNull();
      expect(JSON.parse(log!.before!).id).toBe(project.id);
    });

    // H84
    it("H84 enqueues exactly one ProjectDelete job with the project/org payload", async () => {
      const project = await createProjectRow({
        name: `C2b Delete Queue ${unique()}`,
        orgId: pOrg.id,
      });
      const res = await makeAPICall(
        "DELETE",
        `/api/public/projects/${project.id}`,
        undefined,
        pOrgAuth(),
      );
      expect(res.status).toBe(202);

      const jobs = await findProjectDeleteJobs(project.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe(QueueName.ProjectDelete);
      expect(jobs[0].payload).toMatchObject({
        projectId: project.id,
        orgId: pOrg.id,
      });
    });
  });

  // =====================================================================
  // §D.5 project route wrapper ordering
  // =====================================================================
  describe("project route wrapper ordering", () => {
    // H86
    it("H86 returns 405 before auth for GET, POST and PATCH", async () => {
      for (const method of ["GET", "POST", "PATCH"] as const) {
        const res = await makeAPICall(
          method,
          `/api/public/projects/${pProject.id}`,
          method === "GET" ? undefined : {},
          pOrgAuth(),
        );
        expect(res.status).toBe(405);
        expect((res.body as any).error).toContain("Method not allowed");
      }
    });

    // H87
    it("H87 pins the 405 body's allowed-method list", async () => {
      const res = await makeAPICall(
        "PATCH",
        `/api/public/projects/${pProject.id}`,
        {},
        pOrgAuth(),
      );
      expect(res.status).toBe(405);
      expect((res.body as any).error).toBe(
        "Method not allowed. Allowed methods: PUT, DELETE",
      );
    });

    // H88
    it("H88 checks the method before authentication", async () => {
      const res = await unauthed("GET", `/api/public/projects/${pProject.id}`);
      expect(res.status).toBe(405);
      expect((await res.json()).error).toBe(
        "Method not allowed. Allowed methods: PUT, DELETE",
      );
    });

    // H74 (mapped, but pins the exact body key/message on this route)
    it("H74 returns the documented 404 for an unknown project", async () => {
      const res = await makeAPICall(
        "PUT",
        `/api/public/projects/${randomUUID()}`,
        { name: `C2b Unknown ${unique()}` },
        pOrgAuth(),
      );
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        message: "Project not found or you don't have access to it",
      });
    });
  });
});
