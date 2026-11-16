/** @jest-environment node */

/**
 * Characterisation tests for the "keys-and-memberships" clean-room batch
 * (spec: docs/ee-independence/02-keys-and-memberships/spec.md).
 *
 * Author: Select DB — the party that has read the original implementations and
 * therefore owns the specification, the tests and the gates. The implementation
 * is written by Zhang Mo, who never sees the originals; the role convention is
 * documented in docs/ee-independence/README.md.
 *
 * Everything here is black box: HTTP calls through `makeAPICall` /
 * `makeZodVerifiedAPICall` (server on http://localhost:3000) plus assertions on
 * the HTTP response and on Postgres state through `prisma`. The only direct
 * module imports are `web/src/features/enterprise/http.ts` (C1-C4), whose only
 * observable surface is a direct call, and the pure test-utility helpers.
 *
 * Spec cases implemented in this file (new cases from §7.1-§7.10):
 *   C1, C2, C3, C4, C6, C7, C8, C11, C15, C19, C26, C27, C28, C29, C37, C38,
 *   C42, C43, C44, C46, C48, C51, C54, C55, C58, C59, C61, C63 (+C94), C68,
 *   C69, C73, C74, C75, C77, C78, C86, C89, C90, C91, C92, C95, C96.
 *
 * Mapped to already-existing suites (not re-implemented here, kept green):
 *   memberships-api.servertest.ts  -> C60, C62, C64, C65, C66, C67, C70, C71,
 *                                    C72, C76, C79, C81, C82, C83, C84, C85,
 *                                    C87, C88
 *   projects-api.servertest.ts     -> C30, C31, C32, C33, C34, C35, C36, C40,
 *                                    C41, C45, C47, C49, C50, C52, C53, C56,
 *                                    C57
 *   organizations-api.servertest.ts-> C5, C9, C10, C12, C13, C14, C16, C17,
 *                                    C18, C20, C21, C22, C23, C24, C25, C97
 *
 * ---------------------------------------------------------------------------
 * SPECIFIED BUT NOT ASSERTABLE (with reason) -- see the batch report for detail
 * ---------------------------------------------------------------------------
 * [C39] "POST with an empty body -> 400 Invalid request body" is FALSE for the
 *   current implementation. Next.js turns the body of a body-less POST into
 *   `{}`, and CreateProjectApiKeyBody has only optional fields, so the request
 *   succeeds with 201 and creates a key. Asserting the spec's 400 would fail;
 *   asserting the observed 201 would silently bless behaviour the spec does not
 *   describe. The case is therefore omitted. (Empirically: POST .../apiKeys with
 *   no body -> 201.)
 * [C80] "plan without rbac-project-roles -> 403 'Your plan does not include
 *   project role management.'" is unreachable. requireAdminApi already rejects
 *   any plan without `admin-api`, and in entitlementAccess.ts `admin-api` is only
 *   granted by cloud:pro and self-hosted:enterprise -- both of which also grant
 *   `rbac-project-roles`. So the rbac gate in E.6 can never be the first failure.
 *   (Also `cloudConfig.plan` only accepts "Pro" | "Developer" in getPlan.ts, so a
 *   literal plan of "oss" cannot even be constructed while the cloud region is
 *   configured.) The case is omitted; the gate is dead code in practice.
 * [C93] "missing/array projectId -> 400 {error:'projectId is required'}" is
 *   unreachable over HTTP with this Next.js version: an empty dynamic segment is
 *   308-redirected, and a repeated `?projectId=` query parameter does not surface
 *   as an array (the route parameter wins). The case is omitted.
 *
 * ---------------------------------------------------------------------------
 * SPEC CONTRADICTION FOUND WHILE WRITING THIS FILE
 * ---------------------------------------------------------------------------
 * [C38] spec §B.1 step 1 / §7.5 says the project-level 400 body is
 *   `{ message: "Invalid request body", details: <zod error.issues array> }`.
 *   The current implementation returns `details: error.format()` (an object, not
 *   an array). The test below pins only the parts the spec and the implementation
 *   agree on (status 400, message "Invalid request body", `details` present) and
 *   deliberately does NOT assert the array shape, because doing so would either
 *   fail now or freeze the contradiction.
 */

import {
  makeAPICall,
  makeZodVerifiedAPICall,
} from "@/src/__tests__/test-utils";
import { prisma } from "@langfuse/shared/src/db";
import { Role } from "@langfuse/shared";
import {
  createAndAddApiKeysToDb,
  createBasicAuthHeader,
} from "@langfuse/shared/src/server";
import { allowMethods, routeByMethod } from "@/src/features/enterprise/http";
import type { NextApiRequest, NextApiResponse } from "next";
import { createHash, randomUUID } from "crypto";
import { z } from "zod/v4";

// First HTTP call of the run may compile a route on the dev server.
jest.setTimeout(120_000);

const adminAuth = () => `Bearer ${process.env.ADMIN_API_KEY}`;
const basic = (publicKey: string, secretKey: string) =>
  createBasicAuthHeader(publicKey, secretKey);
const unique = () => randomUUID().slice(0, 8);

/** sha256(secretKey || sha256hex(SALT)) -- the documented fast-hash invariant. */
const expectedFastHash = (secretKey: string) =>
  createHash("sha256")
    .update(secretKey)
    .update(
      createHash("sha256")
        .update(process.env.SALT as string, "utf8")
        .digest("hex"),
    )
    .digest("hex");

type ApiKeyMeta = {
  id: string;
  publicKey: string;
  secretKey: string;
  displaySecretKey: string;
  note: string | null;
  createdAt: Date;
};

const ApiKeyListSchema = z.object({
  apiKeys: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      expiresAt: z.string().nullable(),
      lastUsedAt: z.string().nullable(),
      note: z.string().nullable(),
      publicKey: z.string(),
      displaySecretKey: z.string(),
    }),
  ),
});

const ORG_API_KEY_PROJECTION = [
  "createdAt",
  "displaySecretKey",
  "expiresAt",
  "id",
  "lastUsedAt",
  "note",
  "publicKey",
].sort();

const MEMBERSHIP_PROJECTION = ["email", "name", "role", "userId"].sort();

describe("http.ts method helpers (black-box module surface)", () => {
  type Calls = { status?: number; body?: unknown };
  const makeRes = () => {
    const calls: Calls = {};
    const res = {
      status(code: number) {
        calls.status = code;
        return res;
      },
      json(body: unknown) {
        calls.body = body;
        return res;
      },
    };
    return { res: res as unknown as NextApiResponse, calls, raw: res };
  };

  // C1
  it("C1 allowMethods returns true and writes nothing for an allowed method", () => {
    const { res, calls } = makeRes();
    const result = allowMethods({ method: "POST" } as NextApiRequest, res, [
      "GET",
      "POST",
    ]);
    expect(result).toBe(true);
    expect(calls.status).toBeUndefined();
    expect(calls.body).toBeUndefined();
  });

  // C2
  it("C2 allowMethods writes 405 with the allowed methods for a disallowed method", () => {
    const { res, calls } = makeRes();
    const result = allowMethods({ method: "PATCH" } as NextApiRequest, res, [
      "GET",
      "PUT",
      "DELETE",
    ]);
    expect(result).toBe(false);
    expect(calls.status).toBe(405);
    expect(calls.body).toEqual({
      error: "Method not allowed. Allowed methods: GET, PUT, DELETE",
    });
  });

  // C3
  it("C3 allowMethods treats a missing method as not allowed", () => {
    const { res, calls } = makeRes();
    const result = allowMethods(
      { method: undefined } as unknown as NextApiRequest,
      res,
      ["GET", "PUT", "DELETE"],
    );
    expect(result).toBe(false);
    expect(calls.status).toBe(405);
    expect(calls.body).toEqual({
      error: "Method not allowed. Allowed methods: GET, PUT, DELETE",
    });
  });

  // C4
  it("C4 routeByMethod dispatches by method, passes async results through una awaited, and lists keys in insertion order on 405", () => {
    const handlers = {
      GET: () => "get-result",
      PUT: () => "put-result",
      DELETE: () => "delete-result",
    };
    const { res, calls } = makeRes();
    expect(
      routeByMethod({ method: "GET" } as NextApiRequest, res, handlers),
    ).toBe("get-result");
    expect(calls.status).toBeUndefined();

    // No `await`: a returned promise is passed through by identity.
    const pending = Promise.resolve("async-result");
    const { res: res2 } = makeRes();
    expect(
      routeByMethod({ method: "PUT" } as NextApiRequest, res2, {
        PUT: () => pending,
      }),
    ).toBe(pending);

    const { res: res3, calls: calls3, raw } = makeRes();
    const ret = routeByMethod(
      { method: "PATCH" } as NextApiRequest,
      res3,
      handlers,
    );
    expect(calls3.status).toBe(405);
    expect(calls3.body).toEqual({
      error: "Method not allowed. Allowed methods: GET, PUT, DELETE",
    });
    expect(ret).toBe(raw);
  });
});

describe("keys-and-memberships API characterisation", () => {
  if (!process.env.ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY must be set for the instance-admin cases");
  }

  // Own fixtures, unique names, cleaned up in afterAll.
  let orgA: { id: string };
  let orgB: { id: string };
  let orgDev: { id: string };
  let orgOwners: { id: string };
  let orgAdmin: { id: string };
  let projectA: { id: string };
  let projectA2: { id: string };
  let projectDeleted: { id: string };
  let projectB: { id: string };
  let orgAKey: ApiKeyMeta;
  let orgBKey: ApiKeyMeta;
  let orgDevKey: ApiKeyMeta;
  let projectAKey: ApiKeyMeta;
  let userOrgA: { id: string };
  let userOrgB: { id: string };

  const createdOrgIds: string[] = [];
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];

  const newOrg = async (plan: "Pro" | "Developer" = "Pro") => {
    const org = await prisma.organization.create({
      data: { name: `Keys/Memberships ${unique()}`, cloudConfig: { plan } },
    });
    createdOrgIds.push(org.id);
    return org;
  };
  const newProject = async (orgId: string, opts: { deletedAt?: Date } = {}) => {
    const project = await prisma.project.create({
      data: {
        name: `Project ${unique()}`,
        orgId,
        ...(opts.deletedAt ? { deletedAt: opts.deletedAt } : {}),
      },
    });
    createdProjectIds.push(project.id);
    return project;
  };
  const newUser = async () => {
    const user = await prisma.user.create({
      data: {
        email: `user-${unique()}@example.com`,
        name: `User ${unique()}`,
      },
    });
    createdUserIds.push(user.id);
    return user;
  };
  const newOrgKey = async (orgId: string, note?: string) =>
    (await createAndAddApiKeysToDb({
      prisma,
      entityId: orgId,
      scope: "ORGANIZATION",
      note,
    })) as ApiKeyMeta;
  const newProjectKey = async (projectId: string, note?: string) =>
    (await createAndAddApiKeysToDb({
      prisma,
      entityId: projectId,
      scope: "PROJECT",
      note,
    })) as ApiKeyMeta;

  const orgAAuth = () => basic(orgAKey.publicKey, orgAKey.secretKey);
  const projectAKeysUrl = () => `/api/public/projects/${projectA.id}/apiKeys`;
  const projectAMembershipsUrl = () =>
    `/api/public/projects/${projectA.id}/memberships`;
  const adminOrgKeysUrl = () =>
    `/api/admin/organizations/${orgAdmin.id}/apiKeys`;

  beforeAll(async () => {
    orgA = await newOrg("Pro");
    orgB = await newOrg("Pro");
    orgDev = await newOrg("Developer");
    orgOwners = await newOrg("Pro");
    orgAdmin = await newOrg("Pro");

    projectA = await newProject(orgA.id);
    projectA2 = await newProject(orgA.id);
    projectDeleted = await newProject(orgA.id, { deletedAt: new Date() });
    projectB = await newProject(orgB.id);

    orgAKey = await newOrgKey(orgA.id, "orgA fixture key");
    orgBKey = await newOrgKey(orgB.id, "orgB fixture key");
    orgDevKey = await newOrgKey(orgDev.id, "orgDev fixture key");
    projectAKey = await newProjectKey(projectA.id, "projectA fixture key");

    userOrgA = await newUser();
    await prisma.organizationMembership.create({
      data: { orgId: orgA.id, userId: userOrgA.id, role: Role.MEMBER },
    });
    userOrgB = await newUser();
    await prisma.organizationMembership.create({
      data: { orgId: orgB.id, userId: userOrgB.id, role: Role.MEMBER },
    });
  });

  afterAll(async () => {
    const orgIds = [...createdOrgIds];
    const projectIds = [...createdProjectIds];
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
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  });

  // ------------------------------------------------------------------
  // §7.2 organization API key -- creation (admin entry)
  // ------------------------------------------------------------------
  describe("organization API key creation (admin entry)", () => {
    // C6
    it("C6 creates a key with note null for an empty body", async () => {
      const res = await makeAPICall("POST", adminOrgKeysUrl(), {}, adminAuth());
      expect(res.status).toBe(201);
      const body = res.body as any;
      expect(body.note).toBeNull();
      const row = await prisma.apiKey.findUnique({ where: { id: body.id } });
      expect(row?.note).toBeNull();
    });

    // C7
    it("C7 rejects a non-string note with 400 Invalid request body", async () => {
      const res = await makeAPICall(
        "POST",
        adminOrgKeysUrl(),
        { note: 5 },
        adminAuth(),
      );
      expect(res.status).toBe(400);
      const body = res.body as any;
      expect(body.error).toBe("Invalid request body");
      expect(body.details).toBeDefined();
      expect(typeof body.details).toBe("object");
      // Spec A.1 freezes details as the zod error.format() object (not an array).
      expect(Array.isArray(body.details)).toBe(false);
    });

    // C8
    it("C8 ignores unknown body fields", async () => {
      const res = await makeAPICall(
        "POST",
        adminOrgKeysUrl(),
        { note: "C8 note", foo: "bar" },
        adminAuth(),
      );
      expect(res.status).toBe(201);
      const body = res.body as any;
      expect(body.note).toBe("C8 note");
      expect(body).not.toHaveProperty("foo");
      // Creation response projection is exactly the six documented fields.
      expect(Object.keys(body).sort()).toEqual(
        [
          "createdAt",
          "displaySecretKey",
          "id",
          "note",
          "publicKey",
          "secretKey",
        ].sort(),
      );
    });

    // C11 (also strengthens C5: projection, display key, hashed vs plaintext)
    it("C11 pins the create response projection, hashed/plaintext secrets and the create audit log", async () => {
      const note = `C11 ${unique()}`;
      const res = await makeAPICall(
        "POST",
        adminOrgKeysUrl(),
        { note },
        adminAuth(),
      );
      expect(res.status).toBe(201);
      const body = res.body as any;
      expect(body.publicKey).toMatch(/^pk-lf-/);
      expect(body.secretKey).toMatch(/^sk-lf-/);
      expect(body.note).toBe(note);
      expect(body.displaySecretKey).toBe(
        body.secretKey.slice(0, 6) + "..." + body.secretKey.slice(-4),
      );

      const row = await prisma.apiKey.findUnique({ where: { id: body.id } });
      expect(row).not.toBeNull();
      expect(row!.orgId).toBe(orgAdmin.id);
      expect(row!.projectId).toBeNull();
      expect(row!.scope).toBe("ORGANIZATION");
      // Only the hash is persisted; the plaintext is never stored.
      expect(row!.hashedSecretKey).not.toBe(body.secretKey);
      expect(row!.fastHashedSecretKey).toBe(expectedFastHash(body.secretKey));

      const log = await prisma.auditLog.findFirst({
        where: { orgId: orgAdmin.id, resourceId: body.id },
      });
      expect(log).not.toBeNull();
      expect(log!.type).toBe("API_KEY");
      expect(log!.apiKeyId).toBe("admin-api");
      expect(log!.userId).toBeNull();
      expect(log!.orgId).toBe(orgAdmin.id);
      expect(log!.projectId).toBeNull();
      expect(log!.userOrgRole).toBeNull();
      expect(log!.userProjectRole).toBeNull();
      expect(log!.resourceType).toBe("apiKey");
      expect(log!.resourceId).toBe(body.id);
      expect(log!.action).toBe("create");
      expect(log!.before).toBeNull();
      expect(log!.after).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // §7.4 organization API key -- deletion (admin entry)
  // ------------------------------------------------------------------
  describe("organization API key deletion (admin entry)", () => {
    // C26
    it("C26 returns 404 and keeps the key when the key belongs to another organization", async () => {
      const res = await makeAPICall(
        "DELETE",
        `/api/admin/organizations/${orgA.id}/apiKeys/${orgBKey.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(404);
      expect((res.body as any).error).toBe("API key not found");
      expect(
        await prisma.apiKey.findUnique({ where: { id: orgBKey.id } }),
      ).not.toBeNull();
    });

    // C27
    it("C27 returns 404 when the id names a PROJECT-scope key of the same organization", async () => {
      const res = await makeAPICall(
        "DELETE",
        `/api/admin/organizations/${orgA.id}/apiKeys/${projectAKey.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(404);
      expect((res.body as any).error).toBe("API key not found");
      expect(
        await prisma.apiKey.findUnique({ where: { id: projectAKey.id } }),
      ).not.toBeNull();
    });

    // C28
    it("C28 writes a delete audit log with actor admin-api and no projectId", async () => {
      const doomed = await newOrgKey(orgA.id, `C28 ${unique()}`);
      const res = await makeAPICall(
        "DELETE",
        `/api/admin/organizations/${orgA.id}/apiKeys/${doomed.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(200);
      expect((res.body as any).success).toBe(true);
      expect(
        await prisma.apiKey.findUnique({ where: { id: doomed.id } }),
      ).toBeNull();

      const log = await prisma.auditLog.findFirst({
        where: { orgId: orgA.id, resourceId: doomed.id, action: "delete" },
      });
      expect(log).not.toBeNull();
      expect(log!.type).toBe("API_KEY");
      expect(log!.apiKeyId).toBe("admin-api");
      expect(log!.projectId).toBeNull();
      expect(log!.resourceType).toBe("apiKey");
      expect(log!.userId).toBeNull();
    });

    // C29
    it("C29 returns 405 for GET on the admin delete endpoint", async () => {
      const res = await makeAPICall(
        "GET",
        `/api/admin/organizations/${orgA.id}/apiKeys/${orgAKey.id}`,
        undefined,
        adminAuth(),
      );
      expect(res.status).toBe(405);
      expect((res.body as any).error).toContain("Method not allowed");
      expect((res.body as any).error).toContain("DELETE");
    });
  });

  // ------------------------------------------------------------------
  // §7.3 organization API key -- list (public)
  // ------------------------------------------------------------------
  describe("organization API key listing (public)", () => {
    // C15 (also pins the exact list projection from C12)
    it("C15 lists only ORGANIZATION-scope keys with exactly the 7 documented fields and no secret material", async () => {
      const { body, status } = await makeZodVerifiedAPICall(
        ApiKeyListSchema,
        "GET",
        "/api/public/organizations/apiKeys",
        undefined,
        orgAAuth(),
        200,
      );
      expect(status).toBe(200);
      const ids = body.apiKeys.map((k) => k.id);
      expect(ids).toContain(orgAKey.id);
      expect(ids).not.toContain(projectAKey.id);
      for (const key of body.apiKeys) {
        expect(Object.keys(key).sort()).toEqual(ORG_API_KEY_PROJECTION);
        expect(key).not.toHaveProperty("secretKey");
        expect(key).not.toHaveProperty("hashedSecretKey");
        expect(key).not.toHaveProperty("fastHashedSecretKey");
        expect(key).not.toHaveProperty("projectId");
        expect(key).not.toHaveProperty("orgId");
        expect(key).not.toHaveProperty("scope");
      }
    });

    // C19
    it("C19 rejects an unauthenticated POST with 401 (auth runs before method dispatch)", async () => {
      // `makeAPICall` without an auth argument falls back to `Basic
      // pk-lf-1234567890:sk-lf-1234567890`, which the seed fixtures make a REAL key.
      // With that key the request authenticates and is then rejected by the plan gate
      // (403), which says nothing about "auth runs before method dispatch". Send an
      // explicitly invalid key so the case pins the 401 it is named after.
      const res = await makeAPICall(
        "POST",
        "/api/public/organizations/apiKeys",
        {
          note: "x",
        },
        "Basic cGstbGYtaW52YWxpZDpzay1sZi1pbnZhbGlk", // pk-lf-invalid:sk-lf-invalid
      );
      expect(res.status).toBe(401);
      expect(typeof (res.body as any).error).toBe("string");
    });
  });

  // ------------------------------------------------------------------
  // §7.5 project API key -- creation
  // ------------------------------------------------------------------
  describe("project API key creation", () => {
    // C37
    it("C37 returns 409 when the same secretKey is registered under a different publicKey", async () => {
      const secretKey = `sk-lf-${randomUUID()}`;
      const first = await makeAPICall(
        "POST",
        projectAKeysUrl(),
        { publicKey: `pk-lf-${randomUUID()}`, secretKey },
        orgAAuth(),
      );
      expect(first.status).toBe(201);

      const second = await makeAPICall(
        "POST",
        projectAKeysUrl(),
        { publicKey: `pk-lf-${randomUUID()}`, secretKey },
        orgAAuth(),
      );
      expect(second.status).toBe(409);
      expect((second.body as any).message).toContain("already in use");
    });

    // C38 -- details shape deliberately not asserted (spec/implementation contradiction).
    it("C38 rejects a non-string note with 400 Invalid request body and a details payload", async () => {
      const res = await makeAPICall(
        "POST",
        projectAKeysUrl(),
        { note: 5 },
        orgAAuth(),
      );
      expect(res.status).toBe(400);
      const body = res.body as any;
      expect(body.message).toBe("Invalid request body");
      expect(body.details).toBeDefined();
    });

    // C42
    it("C42 returns 404 Project not found when the project belongs to another organization", async () => {
      const res = await makeAPICall(
        "POST",
        `/api/public/projects/${projectB.id}/apiKeys`,
        { note: "C42" },
        orgAAuth(),
      );
      expect(res.status).toBe(404);
      expect((res.body as any).message).toBe(
        "Project not found or you don't have access to it",
      );
    });

    // C43
    it("C43 returns the same 404 when the project is soft-deleted", async () => {
      const res = await makeAPICall(
        "POST",
        `/api/public/projects/${projectDeleted.id}/apiKeys`,
        { note: "C43" },
        orgAAuth(),
      );
      expect(res.status).toBe(404);
      expect((res.body as any).message).toBe(
        "Project not found or you don't have access to it",
      );
    });

    // C44
    it("C44 writes a project create audit log with the calling key as actor", async () => {
      const note = `C44 ${unique()}`;
      const res = await makeAPICall(
        "POST",
        projectAKeysUrl(),
        { note },
        orgAAuth(),
      );
      expect(res.status).toBe(201);
      const body = res.body as any;
      expect(body.publicKey).toMatch(/^pk-lf-/);
      expect(body.secretKey).toMatch(/^sk-lf-/);
      expect(body.note).toBe(note);

      const row = await prisma.apiKey.findUnique({ where: { id: body.id } });
      expect(row?.projectId).toBe(projectA.id);
      expect(row?.orgId).toBeNull();
      expect(row?.scope).toBe("PROJECT");

      const log = await prisma.auditLog.findFirst({
        where: {
          orgId: orgA.id,
          projectId: projectA.id,
          resourceId: body.id,
          action: "create",
        },
      });
      expect(log).not.toBeNull();
      expect(log!.type).toBe("API_KEY");
      expect(log!.apiKeyId).toBe(orgAKey.id);
      expect(log!.resourceType).toBe("apiKey");
    });

    // C46
    it("C46 returns 405 before auth for an unsupported method", async () => {
      const res = await makeAPICall("PUT", projectAKeysUrl(), { note: "C46" });
      expect(res.status).toBe(405);
      expect((res.body as any).error).toContain("Method not allowed");
      expect((res.body as any).error).toContain("GET, POST");
    });
  });

  // ------------------------------------------------------------------
  // §7.6 project API key -- list
  // ------------------------------------------------------------------
  describe("project API key listing", () => {
    // C48
    it("C48 does not leak keys of another project", async () => {
      const otherKey = await newProjectKey(projectA2.id, `C48 ${unique()}`);
      const res = await makeAPICall(
        "GET",
        projectAKeysUrl(),
        undefined,
        orgAAuth(),
      );
      expect(res.status).toBe(200);
      const ids = (res.body as any).apiKeys.map((k: any) => k.id);
      expect(ids).toContain(projectAKey.id);
      expect(ids).not.toContain(otherKey.id);
    });

    // C51
    it("C51 rejects a project-scoped key with 403", async () => {
      const res = await makeAPICall(
        "GET",
        projectAKeysUrl(),
        undefined,
        basic(projectAKey.publicKey, projectAKey.secretKey),
      );
      expect(res.status).toBe(403);
      expect((res.body as any).error).toContain(
        "Organization-scoped API key required",
      );
    });
  });

  // ------------------------------------------------------------------
  // §7.7 project API key -- deletion
  // ------------------------------------------------------------------
  describe("project API key deletion", () => {
    // C54
    it("C54 returns 404 for a key of another project and keeps it", async () => {
      const otherKey = await newProjectKey(projectA2.id, `C54 ${unique()}`);
      const res = await makeAPICall(
        "DELETE",
        `${projectAKeysUrl()}/${otherKey.id}`,
        undefined,
        orgAAuth(),
      );
      expect(res.status).toBe(404);
      expect((res.body as any).message).toBe("API key not found");
      expect(
        await prisma.apiKey.findUnique({ where: { id: otherKey.id } }),
      ).not.toBeNull();
    });

    // C55
    it("C55 returns 404 for an ORGANIZATION-scope key id and keeps it", async () => {
      const res = await makeAPICall(
        "DELETE",
        `${projectAKeysUrl()}/${orgAKey.id}`,
        undefined,
        orgAAuth(),
      );
      expect(res.status).toBe(404);
      expect((res.body as any).message).toBe("API key not found");
      expect(
        await prisma.apiKey.findUnique({ where: { id: orgAKey.id } }),
      ).not.toBeNull();
    });

    // C58
    it("C58 returns 405 for GET on the project key delete endpoint", async () => {
      const res = await makeAPICall(
        "GET",
        `${projectAKeysUrl()}/${projectAKey.id}`,
        undefined,
        orgAAuth(),
      );
      expect(res.status).toBe(405);
      expect((res.body as any).error).toContain("Method not allowed");
      expect((res.body as any).error).toContain("DELETE");
    });

    // C59
    it("C59 writes a project delete audit log and the deleted key stops authenticating", async () => {
      const key = await newProjectKey(projectA.id, `C59 ${unique()}`);
      // Warm the auth cache with a successful call, then delete.
      const before = await makeAPICall(
        "GET",
        "/api/public/projects",
        undefined,
        basic(key.publicKey, key.secretKey),
      );
      expect(before.status).toBe(200);

      const res = await makeAPICall(
        "DELETE",
        `${projectAKeysUrl()}/${key.id}`,
        undefined,
        orgAAuth(),
      );
      expect(res.status).toBe(200);
      expect((res.body as any).success).toBe(true);
      expect(
        await prisma.apiKey.findUnique({ where: { id: key.id } }),
      ).toBeNull();

      const log = await prisma.auditLog.findFirst({
        where: {
          orgId: orgA.id,
          projectId: projectA.id,
          resourceId: key.id,
          action: "delete",
        },
      });
      expect(log).not.toBeNull();
      expect(log!.type).toBe("API_KEY");
      expect(log!.apiKeyId).toBe(orgAKey.id);
      expect(log!.resourceType).toBe("apiKey");

      // Cache invalidation observed through behaviour: the row is gone and the
      // previously cached credential no longer authenticates.
      const after = await makeAPICall(
        "GET",
        "/api/public/projects",
        undefined,
        basic(key.publicKey, key.secretKey),
      );
      expect(after.status).toBe(401);

      // Delete is idempotent but its response is not: a second DELETE is a 404.
      const second = await makeAPICall(
        "DELETE",
        `${projectAKeysUrl()}/${key.id}`,
        undefined,
        orgAAuth(),
      );
      expect(second.status).toBe(404);
      expect((second.body as any).message).toBe("API key not found");
    });
  });

  // ------------------------------------------------------------------
  // §7.8 organization memberships
  // ------------------------------------------------------------------
  describe("organization memberships", () => {
    // C61
    it("C61 only lists members of the authenticated organization with the exact projection", async () => {
      const res = await makeAPICall(
        "GET",
        "/api/public/organizations/memberships",
        undefined,
        orgAAuth(),
      );
      expect(res.status).toBe(200);
      const memberships = (res.body as any).memberships as any[];
      expect(Array.isArray(memberships)).toBe(true);
      const ids = memberships.map((m) => m.userId);
      expect(ids).toContain(userOrgA.id);
      expect(ids).not.toContain(userOrgB.id);
      for (const m of memberships) {
        expect(Object.keys(m).sort()).toEqual(MEMBERSHIP_PROJECTION);
      }
    });

    // C63 (also covers C94: identical observable behaviour)
    it("C63/C94 returns 405 listing GET, PUT, DELETE in that order for PATCH", async () => {
      const res = await makeAPICall(
        "PATCH",
        "/api/public/organizations/memberships",
        {},
        orgAAuth(),
      );
      expect(res.status).toBe(405);
      expect((res.body as any).error).toBe(
        "Method not allowed. Allowed methods: GET, PUT, DELETE",
      );
    });

    // C68
    it("C68 allows demoting one of two owners", async () => {
      const owner1 = await newUser();
      const owner2 = await newUser();
      await prisma.organizationMembership.create({
        data: { orgId: orgOwners.id, userId: owner1.id, role: Role.OWNER },
      });
      await prisma.organizationMembership.create({
        data: { orgId: orgOwners.id, userId: owner2.id, role: Role.OWNER },
      });
      const key = await newOrgKey(orgOwners.id, `C68 ${unique()}`);

      const res = await makeAPICall(
        "PUT",
        "/api/public/organizations/memberships",
        { userId: owner1.id, role: Role.MEMBER },
        basic(key.publicKey, key.secretKey),
      );
      expect(res.status).toBe(200);
      expect((res.body as any).role).toBe(Role.MEMBER);

      const row = await prisma.organizationMembership.findUnique({
        where: {
          orgId_userId: { orgId: orgOwners.id, userId: owner1.id },
        },
      });
      expect(row?.role).toBe(Role.MEMBER);
      const other = await prisma.organizationMembership.findUnique({
        where: {
          orgId_userId: { orgId: orgOwners.id, userId: owner2.id },
        },
      });
      expect(other?.role).toBe(Role.OWNER);
    });

    // C69
    it("C69 rejects an out-of-enum role with 400 Invalid request body", async () => {
      const res = await makeAPICall(
        "PUT",
        "/api/public/organizations/memberships",
        { userId: userOrgA.id, role: "SUPERUSER" },
        orgAAuth(),
      );
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain("Invalid request body");
    });

    // C73
    it("C73 deleting a non-existent membership returns 200 and echoes the userId", async () => {
      const ghost = randomUUID();
      const res = await makeAPICall(
        "DELETE",
        "/api/public/organizations/memberships",
        { userId: ghost },
        orgAAuth(),
      );
      expect(res.status).toBe(200);
      expect((res.body as any).message).toBe("Organization membership removed");
      expect((res.body as any).userId).toBe(ghost);
    });

    // C74
    it("C74 deleting an organization membership cascades to its project memberships", async () => {
      const user = await newUser();
      const membership = await prisma.organizationMembership.create({
        data: { orgId: orgA.id, userId: user.id, role: Role.MEMBER },
      });
      await prisma.projectMembership.create({
        data: {
          projectId: projectA.id,
          userId: user.id,
          role: Role.VIEWER,
          orgMembershipId: membership.id,
        },
      });

      const res = await makeAPICall(
        "DELETE",
        "/api/public/organizations/memberships",
        { userId: user.id },
        orgAAuth(),
      );
      expect(res.status).toBe(200);
      expect(
        await prisma.projectMembership.findUnique({
          where: {
            projectId_userId: { projectId: projectA.id, userId: user.id },
          },
        }),
      ).toBeNull();
    });

    // C75
    it("C75 membership writes produce no audit log rows", async () => {
      const user = await newUser();
      const key = await newOrgKey(orgOwners.id, `C75 ${unique()}`);
      const before = await prisma.auditLog.count({
        where: { orgId: orgOwners.id },
      });

      const put = await makeAPICall(
        "PUT",
        "/api/public/organizations/memberships",
        { userId: user.id, role: Role.VIEWER },
        basic(key.publicKey, key.secretKey),
      );
      expect(put.status).toBe(200);
      const del = await makeAPICall(
        "DELETE",
        "/api/public/organizations/memberships",
        { userId: user.id },
        basic(key.publicKey, key.secretKey),
      );
      expect(del.status).toBe(200);

      const after = await prisma.auditLog.count({
        where: { orgId: orgOwners.id },
      });
      expect(after).toBe(before);
    });

    // C.2 idempotency: one row per (orgId, userId) even after a repeated PUT.
    it("C.2 upsert is idempotent and keeps exactly one organization membership row", async () => {
      const user = await newUser();
      const first = await makeAPICall(
        "PUT",
        "/api/public/organizations/memberships",
        { userId: user.id, role: Role.VIEWER },
        orgAAuth(),
      );
      expect(first.status).toBe(200);
      const second = await makeAPICall(
        "PUT",
        "/api/public/organizations/memberships",
        { userId: user.id, role: Role.VIEWER },
        orgAAuth(),
      );
      expect(second.status).toBe(200);
      const rows = await prisma.organizationMembership.findMany({
        where: { orgId: orgA.id, userId: user.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe(Role.VIEWER);
    });
  });

  // ------------------------------------------------------------------
  // §7.9 project memberships
  // ------------------------------------------------------------------
  describe("project memberships", () => {
    // C77
    it("C77 omits organization members that have no explicit project membership", async () => {
      const user = await newUser();
      await prisma.organizationMembership.create({
        data: { orgId: orgA.id, userId: user.id, role: Role.MEMBER },
      });
      const res = await makeAPICall(
        "GET",
        projectAMembershipsUrl(),
        undefined,
        orgAAuth(),
      );
      expect(res.status).toBe(200);
      const ids = (res.body as any).memberships.map((m: any) => m.userId);
      expect(ids).not.toContain(user.id);
    });

    // C78
    it("C78 omits a row whose organization membership belongs to another organization", async () => {
      const user = await newUser();
      const foreignMembership = await prisma.organizationMembership.create({
        data: { orgId: orgB.id, userId: user.id, role: Role.MEMBER },
      });
      await prisma.projectMembership.create({
        data: {
          projectId: projectA.id,
          userId: user.id,
          role: Role.VIEWER,
          orgMembershipId: foreignMembership.id,
        },
      });
      const res = await makeAPICall(
        "GET",
        projectAMembershipsUrl(),
        undefined,
        orgAAuth(),
      );
      expect(res.status).toBe(200);
      const ids = (res.body as any).memberships.map((m: any) => m.userId);
      expect(ids).not.toContain(user.id);
    });

    // C86
    it("C86 upsert updates only the role and leaves an inconsistent orgMembershipId untouched", async () => {
      const user = await newUser();
      await prisma.organizationMembership.create({
        data: { orgId: orgA.id, userId: user.id, role: Role.MEMBER },
      });
      const foreignMembership = await prisma.organizationMembership.create({
        data: { orgId: orgB.id, userId: user.id, role: Role.MEMBER },
      });
      await prisma.projectMembership.create({
        data: {
          projectId: projectA.id,
          userId: user.id,
          role: Role.VIEWER,
          orgMembershipId: foreignMembership.id,
        },
      });

      const res = await makeAPICall(
        "PUT",
        projectAMembershipsUrl(),
        { userId: user.id, role: Role.ADMIN },
        orgAAuth(),
      );
      expect(res.status).toBe(200);
      expect((res.body as any).role).toBe(Role.ADMIN);

      const row = await prisma.projectMembership.findUnique({
        where: {
          projectId_userId: { projectId: projectA.id, userId: user.id },
        },
      });
      expect(row?.role).toBe(Role.ADMIN);
      expect(row?.orgMembershipId).toBe(foreignMembership.id);
    });

    // C89
    it("C89 returns 403 for a membership that belongs to another organization and keeps it", async () => {
      const user = await newUser();
      const foreignMembership = await prisma.organizationMembership.create({
        data: { orgId: orgB.id, userId: user.id, role: Role.MEMBER },
      });
      await prisma.projectMembership.create({
        data: {
          projectId: projectA.id,
          userId: user.id,
          role: Role.VIEWER,
          orgMembershipId: foreignMembership.id,
        },
      });

      const res = await makeAPICall(
        "DELETE",
        projectAMembershipsUrl(),
        { userId: user.id },
        orgAAuth(),
      );
      expect(res.status).toBe(403);
      expect((res.body as any).error).toBe(
        "Project membership does not belong to this organization",
      );
      expect(
        await prisma.projectMembership.findUnique({
          where: {
            projectId_userId: { projectId: projectA.id, userId: user.id },
          },
        }),
      ).not.toBeNull();
    });

    // C90
    it("C90 rejects a missing userId with 400 Invalid request body", async () => {
      const res = await makeAPICall(
        "DELETE",
        projectAMembershipsUrl(),
        {},
        orgAAuth(),
      );
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain("Invalid request body");
    });

    // C91
    it("C91 project membership writes produce no audit log rows", async () => {
      const user = await newUser();
      await prisma.organizationMembership.create({
        data: { orgId: orgA.id, userId: user.id, role: Role.MEMBER },
      });
      const before = await prisma.auditLog.count({
        where: { projectId: projectA.id },
      });
      const res = await makeAPICall(
        "PUT",
        projectAMembershipsUrl(),
        { userId: user.id, role: Role.ADMIN },
        orgAAuth(),
      );
      expect(res.status).toBe(200);
      const after = await prisma.auditLog.count({
        where: { projectId: projectA.id },
      });
      expect(after).toBe(before);
    });

    // C.3 idempotency: the composite primary key keeps a repeated PUT at one row.
    it("C.3 upsert is idempotent and keeps exactly one project membership row", async () => {
      const user = await newUser();
      await prisma.organizationMembership.create({
        data: { orgId: orgA.id, userId: user.id, role: Role.MEMBER },
      });
      const first = await makeAPICall(
        "PUT",
        projectAMembershipsUrl(),
        { userId: user.id, role: Role.VIEWER },
        orgAAuth(),
      );
      expect(first.status).toBe(200);
      const second = await makeAPICall(
        "PUT",
        projectAMembershipsUrl(),
        { userId: user.id, role: Role.VIEWER },
        orgAAuth(),
      );
      expect(second.status).toBe(200);
      const rows = await prisma.projectMembership.findMany({
        where: { projectId: projectA.id, userId: user.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe(Role.VIEWER);
    });
  });

  // ------------------------------------------------------------------
  // §7.10 route ordering and cross-cutting concerns
  // ------------------------------------------------------------------
  describe("route ordering and cross-cutting concerns", () => {
    // C92
    it("C92 returns 405 before auth for PATCH on project memberships", async () => {
      const res = await makeAPICall("PATCH", projectAMembershipsUrl(), {});
      expect(res.status).toBe(405);
      expect((res.body as any).error).toContain(
        "Allowed methods: GET, PUT, DELETE",
      );
    });

    // C95
    it("C95 returns 403 This feature is not available on your current plan for a plan without admin-api", async () => {
      const res = await makeAPICall(
        "GET",
        "/api/public/organizations/apiKeys",
        undefined,
        basic(orgDevKey.publicKey, orgDevKey.secretKey),
      );
      expect(res.status).toBe(403);
      expect((res.body as any).error).toBe(
        "This feature is not available on your current plan.",
      );
    });

    // C96
    it("C96 answers CORS preflight without authentication", async () => {
      const origin = "https://characterisation.example";
      const res = await fetch(
        "http://localhost:3000/api/public/organizations/apiKeys",
        {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "GET",
          },
        },
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect((res.headers.get("vary") ?? "").toLowerCase()).toContain("origin");
    });
  });
});
