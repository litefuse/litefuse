/** @jest-environment node */

/**
 * Characterisation tests for the auth + SSO batch (batch 3a) of the clean-room
 * reimplementation (spec: docs/ee-independence/03-auth-sso/spec.md).
 *
 * Author: Select DB — the party that has read the original implementations and
 * therefore owns the specification, the tests and the gates. The implementation
 * is written by Zhang Mo, who never sees the originals; the role convention is
 * documented in docs/ee-independence/README.md.
 *
 * Targets covered by this file:
 *   web/src/server/adminApiAuth.ts                      (A1-A13)
 *   web/src/features/enterprise/auth/requireInstanceAdmin.ts (B1-B5)
 *   web/src/features/enterprise/auth/requireAdminApi.ts (C1-C4)
 *   web/src/features/enterprise/sso/ssoProviders.ts     (G1-G18, X2)
 *   web/src/features/enterprise/sso/createSsoConfig.ts  (E1-E15)
 *   web/src/pages/api/auth/add-sso-config.ts            (R1-R2, HTTP)
 *   web/src/pages/api/auth/check-sso.ts                 (F1-F7, direct)
 *
 * HOW THIS FILE TESTS
 * `adminApiAuth`, `requireInstanceAdmin` and `requireAdminApi` are middlewares
 * whose only observable surface is the response they write, so they are called
 * with a fake `req`/`res` that records `status`/`json` (the same technique the
 * organisations batch uses). The SSO pieces are asserted through the real
 * `prisma` client and through direct calls of the exported functions /
 * the page handlers with a fake `res`.
 *
 * Cases that need a different process environment (cloud region, unset
 * ADMIN_API_KEY/ENCRYPTION_KEY, multi-tenant SSO disabled, a broken data read)
 * cannot be reached over HTTP without restarting the dev server, so the `env`
 * module and `isMultiTenantSsoAvailable` are mocked; the DB read failure is
 * injected with a spy on `prisma.$transaction`. `ssoProviders` keeps its config
 * cache in module scope, so every G case reloads the module (`jest.resetModules`)
 * to get a cold cache — otherwise the 1-hour TTL would leak between cases.
 * The A/B/C cases stub the shared logger so "was logger.error called?" is
 * observable; the real logger is deliberately NOT spread (its winston instance
 * makes jest hang when it is serialised).
 *
 * Only three cases go over HTTP (the route shells R1/R2 and the 400 shape of
 * add-sso-config, E9). They are optional: they are skipped with a warning when
 * no server answers on :3000, because this batch's HTTP-precondition (a licensed
 * dev server started from this worktree) is environmental, not behavioural.
 *
 * ---------------------------------------------------------------------------
 * KNOWN PRODUCT DECISIONS / RESIDUALS -- NOT to be "fixed" in these tests
 * ---------------------------------------------------------------------------
 * [spec §K.1b] The SSO config read is deliberately FAIL-OPEN. `loadSsoConfigs`
 *   swallows a failed DB read, caches `data: []` and answers every lookup with
 *   "no configuration" for the next 60 seconds; a row that no longer parses is
 *   skipped (and logged) so only that domain loses its SSO requirement. The
 *   product owner reversed an earlier fail-closed patch because a read outage
 *   would otherwise lock out users of unregistered domains too. G5 and G9 pin
 *   this observable fail-open behaviour; there is intentionally no test
 *   asserting that a failed read makes lookups throw.
 * [spec §16.5] `hasSsoConfig()` counts rows with `auth_config IS NULL` while
 *   `buildSsoProviders()` skips them, so `true` can coexist with `[]`. Pinned by
 *   G4 as a known inconsistency.
 * [spec §16.6] A bad `clientSecret` ciphertext makes `buildSsoProviders()` throw
 *   but leaves `resolveSsoProviderIdForDomain()` returning the providerId
 *   (asymmetric). Pinned by G15.
 * [spec §16.7] `adminApiAuth` only compares `split(" ")[1]`, so
 *   `"Bearer <key> extra"` authenticates. Pinned by A4 and deliberately not
 *   "tightened" here.
 * [spec §16.8] The same "no ADMIN_API_KEY" condition answers 403 in
 *   `handleAdminAuth` and 500 in `createSsoConfig` (before auth). Both pinned.
 * [spec §K.2] `createSsoConfig` does not invalidate the provider cache, and the
 *   duplicate-domain pre-check is not atomic (a concurrent duplicate yields 500,
 *   a sequential one 409). Sequential 409 is pinned by E12.
 * [spec §16.11] `/auth/sso-initiate?provider=a&provider=b` and the `!domain`
 *   branch of the enterprise-SSO page are unassertable; they are not tested.
 *
 * ---------------------------------------------------------------------------
 * SPEC CONTRADICTIONS FOUND WHILE WRITING THIS FILE
 * ---------------------------------------------------------------------------
 * None against the target files: every branch in spec §2-§8 was reproduced as
 * written. The only deviations found are (a) the spec's own §16/K.1b fail-open
 * record, which is intentional, and (b) HTTP-only environment limits documented
 * in the file header of `enterpriseSsoInterop.clienttest.ts` (the mandatory
 * export-surface check runs here as X2 because jsdom cannot load the shared
 * server barrel).
 *
 * NOT ASSERTED / OMITTED (with reason)
 *   [X3] "an SSO-enforced domain cannot sign in with a password" needs the
 *     NextAuth credentials callback with a licensed instance whose provider
 *     cache is controlled; the callback is not exported and the gateway caches
 *     the enterprise import per process, so the case cannot be isolated without
 *     mocking the module under test. Covered at the gateway level by the
 *     existing `enterpriseSso.clienttest.ts` (X4).
 *   [G9 second half] "a failed read is retried after 60 s" needs a 60 s wait.
 *     The retry branch is exercised by G8 for the success path; the failed path
 *     is only asserted for "cached once", not for "retried after 60 s".
 *   [G2 literal] "the table is empty -> []/false/null" is not reproducible
 *     against a shared database that other suites also write to. G2 asserts the
 *     observable equivalent for an unconfigured domain and, as a control, that
 *     `hasSsoConfig()` is true while this file's fixtures exist.
 */

import { type NextApiRequest, type NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { z } from "zod/v4";

import { prisma } from "@langfuse/shared/src/db";
import { decrypt, encrypt } from "@langfuse/shared/encryption";
import {
  createBasicAuthHeader,
  logger,
  traceException,
} from "@langfuse/shared/src/server";
import { makeAPICall } from "@/src/__tests__/test-utils";
import { AdminApiAuthService } from "@/src/server/adminApiAuth";
import { requireInstanceAdmin } from "@/src/features/enterprise/auth/requireInstanceAdmin";
import { requireAdminApi } from "@/src/features/enterprise/auth/requireAdminApi";

// The web server compiles routes on demand; the first HTTP call may be slow.
jest.setTimeout(120_000);

/**
 * `env` from env.mjs is a frozen `createEnv()` result, so the cases that need a
 * different ADMIN_API_KEY / cloud region have to mock the module before it is
 * imported. The copy stays writable. Same technique as
 * `admin-api-key-auth.servertest.ts` (which uses the same relative specifier
 * because aliases are not resolved inside `jest.doMock`).
 */
jest.mock("../../env.mjs", () => {
  const actual = jest.requireActual("../../env.mjs");
  return { ...actual, env: { ...actual.env } };
});

// `isMultiTenantSsoAvailable` is computed once at module evaluation, so the
// cases that need an unlicensed instance need it mocked. The flag is read by the
// factory on every evaluation; `setSsoAvailable()` flips it between cases. It is
// deliberately NOT combined with `jest.resetModules()`: reloading the module
// registry also re-evaluates `@langfuse/shared/src/db`, and the reloaded module
// would then query through a *different* prisma singleton than the one this file
// spies on and seeds through (verified: `prisma` identity changes across
// `jest.resetModules()`).
let ssoAvailable = true;
const setSsoAvailable = (value: boolean) => {
  ssoAvailable = value;
};
jest.mock("../../features/auth/sso/isMultiTenantSsoAvailable", () => ({
  get isMultiTenantSsoAvailable() {
    return ssoAvailable;
  },
}));

/**
 * The shared logger is stubbed so "logger.error was called" is observable. The
 * real winston logger must not be spread into the factory: jest serialises mock
 * state and the winston instance is circular enough to hang the worker.
 */
jest.mock("@langfuse/shared/src/server", () => {
  const actual = jest.requireActual("@langfuse/shared/src/server");
  return {
    ...actual,
    logger: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
    traceException: jest.fn(),
  };
});

// The mocked env module (see the jest.mock above). Importing it through the
// alias keeps this file's static imports uniform; the alias resolves to the same
// file, so the mock applies.
import { env } from "@/src/env.mjs";

const mockLogger = logger as unknown as {
  error: jest.Mock;
  info: jest.Mock;
};
const mockTraceException = traceException as unknown as jest.Mock;

const adminKey = () => process.env.ADMIN_API_KEY as string;
const adminAuth = () => `Bearer ${adminKey()}`;
const unique = () => randomUUID().slice(0, 8);

type ResCalls = {
  statusCode?: number;
  body?: unknown;
  statusCalls: number;
  jsonCalls: number;
};
const createRes = () => {
  const calls: ResCalls = { statusCalls: 0, jsonCalls: 0 };
  const res: Record<string, unknown> = {};
  res.status = (code: number) => {
    calls.statusCode = code;
    calls.statusCalls += 1;
    return res;
  };
  res.json = (body: unknown) => {
    calls.body = body;
    calls.jsonCalls += 1;
    return res;
  };
  return {
    res: res as unknown as NextApiResponse,
    calls,
    status: () => calls.statusCode,
  };
};

/** A request with the given authorization header (or none). */
const req = (authorization?: string | string[]) =>
  ({
    headers: authorization === undefined ? {} : { authorization },
  }) as unknown as NextApiRequest;

/** A request with a body and method, for the page handlers. */
const bodyReq = (method: string, body?: unknown, authorization?: string) =>
  ({
    method,
    body,
    headers: authorization === undefined ? {} : { authorization },
  }) as unknown as NextApiRequest;

/**
 * The id the config was registered under. The built-in next-auth factories
 * (google, okta, ...) keep their own hardcoded top-level `id` and carry the
 * override inside `options.id`; the two locally written factories
 * (`CustomSSOProvider` keeps `options`) and `JumpCloudProvider` (spreads its
 * options onto the provider) expose it as described in G13. Prefer the nested
 * value, fall back to the top level. The public lookup key is
 * `resolveSsoProviderIdForDomain` / `resolveMultiTenantSsoConfig`, asserted by
 * G12; this helper only makes the construction assertions independent of that
 * per-factory quirk.
 */
const providerOptionsId = (provider: unknown): string | undefined => {
  const candidate = provider as { id?: string; options?: { id?: string } };
  return candidate.options?.id ?? candidate.id;
};

type TxDelegate = {
  ssoConfig: { findMany: () => Promise<unknown[]> };
};
/** Run the callback the production code passes to `prisma.$transaction`. */
const firstTransactionCallback = (
  spy: jest.SpyInstance,
): ((tx: TxDelegate) => Promise<unknown[]>) => {
  const callback = spy.mock.calls[0]?.[0];
  if (typeof callback !== "function") {
    throw new Error("prisma.$transaction was not called with a callback");
  }
  return callback as (tx: TxDelegate) => Promise<unknown[]>;
};

/** Domains created by this file, deleted in afterAll. */
const createdDomains: string[] = [];
const ssoConfig = (data: {
  domain: string;
  authProvider: string;
  authConfig: unknown | null;
}) => {
  createdDomains.push(data.domain);
  return prisma.ssoConfig.create({ data: data as never });
};
/**
 * A complete authConfig ready to be stored: the clientSecret is already
 * encrypted the way the application encrypts it.
 */
const authConfigWithSecret = (overrides: Record<string, unknown> = {}) => ({
  clientId: "client-id",
  clientSecret: encrypt("plain-secret"),
  ...overrides,
});

describe("auth + SSO characterisation (batch 3a)", () => {
  if (!process.env.ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY must be set for the instance-admin cases");
  }

  const realAdminApiKey = env.ADMIN_API_KEY;
  const realCloudRegion = env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION;
  const realLicenseKey = process.env.LITEFUSE_EE_LICENSE_KEY;
  const realEncryptionKey = env.ENCRYPTION_KEY;

  beforeEach(() => {
    mockLogger.error.mockClear();
    mockLogger.info.mockClear();
    mockTraceException.mockClear();
  });

  afterAll(async () => {
    // Restore the mutable env copy and the real process env.
    (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY =
      realAdminApiKey;
    (
      env as unknown as { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION?: string }
    ).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = realCloudRegion;
    if (realLicenseKey === undefined) {
      delete process.env.LITEFUSE_EE_LICENSE_KEY;
    } else {
      process.env.LITEFUSE_EE_LICENSE_KEY = realLicenseKey;
    }

    // Self-contained fixtures: only the domains this file created.
    if (createdDomains.length > 0) {
      await prisma.ssoConfig.deleteMany({
        where: { domain: { in: createdDomains } },
      });
    }
  });

  // =========================================================================
  // A1-A13 — AdminApiAuthService.verifyAdminAuthFromAuthString / handleAdminAuth
  // =========================================================================
  describe("A. AdminApiAuthService", () => {
    const restoreEnv = () => {
      (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY =
        realAdminApiKey;
      (
        env as unknown as { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION?: string }
      ).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = realCloudRegion;
    };
    afterEach(restoreEnv);

    // A1
    it("A1 answers 401 with the exact message when no Authorization header is present", () => {
      const { res, status, calls } = createRes();
      expect(AdminApiAuthService.handleAdminAuth(req(), res)).toBe(false);
      expect(status()).toBe(401);
      expect(calls.body).toEqual({
        error: "Unauthorized: authorization header is missing",
      });
    });

    // A2
    it("A2 answers 401 Unauthorized: Invalid token for a wrong Bearer token", () => {
      const { res, status, calls } = createRes();
      expect(
        AdminApiAuthService.handleAdminAuth(
          req("Bearer invalid-admin-key"),
          res,
        ),
      ).toBe(false);
      expect(status()).toBe(401);
      expect(calls.body).toEqual({ error: "Unauthorized: Invalid token" });
    });

    // A3
    it("A3 answers 401 for a Basic header (any non-Bearer scheme)", () => {
      const { res, status, calls } = createRes();
      const basic = createBasicAuthHeader("pk-x", "sk-y");
      expect(AdminApiAuthService.handleAdminAuth(req(basic), res)).toBe(false);
      expect(status()).toBe(401);
      expect(calls.body).toEqual({ error: "Unauthorized: Invalid token" });
    });

    // A4
    it("A4 accepts a correct Bearer token with trailing segments (only part 2 is compared)", () => {
      const outcome = AdminApiAuthService.verifyAdminAuthFromAuthString(
        `Bearer ${adminKey()} extra1 extra2`,
      );
      expect(outcome.isAuthorized).toBe(true);

      const { res, calls } = createRes();
      expect(
        AdminApiAuthService.handleAdminAuth(
          req(`Bearer ${adminKey()} extra1 extra2`),
          res,
        ),
      ).toBe(true);
      // Success must not touch the response at all.
      expect(calls.statusCalls).toBe(0);
      expect(calls.jsonCalls).toBe(0);
    });

    // A5
    it("A5 rejects the lowercase scheme bearer", () => {
      const outcome = AdminApiAuthService.verifyAdminAuthFromAuthString(
        `bearer ${adminKey()}`,
      );
      expect(outcome).toEqual({
        isAuthorized: false,
        error: "Unauthorized: Invalid token",
      });
      const { res, status } = createRes();
      expect(
        AdminApiAuthService.handleAdminAuth(req(`bearer ${adminKey()}`), res),
      ).toBe(false);
      expect(status()).toBe(401);
    });

    // A6
    it("A6 rejects a Bearer token with no second segment", () => {
      const outcome =
        AdminApiAuthService.verifyAdminAuthFromAuthString("Bearer");
      expect(outcome).toEqual({
        isAuthorized: false,
        error: "Unauthorized: Invalid token",
      });
      const { res, status } = createRes();
      expect(AdminApiAuthService.handleAdminAuth(req("Bearer"), res)).toBe(
        false,
      );
      expect(status()).toBe(401);
    });

    // A7
    it("A7 answers 403 ADMIN_API_KEY is not set and logs when the key is unset", () => {
      (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY = undefined;

      const outcome =
        AdminApiAuthService.verifyAdminAuthFromAuthString("Bearer whatever");
      expect(outcome).toEqual({
        isAuthorized: false,
        error: "ADMIN_API_KEY is not set",
      });
      expect(mockLogger.error).toHaveBeenCalled();

      mockLogger.error.mockClear();
      const { res, status, calls } = createRes();
      expect(
        AdminApiAuthService.handleAdminAuth(req("Bearer whatever"), res),
      ).toBe(false);
      expect(status()).toBe(403);
      expect(calls.body).toEqual({ error: "ADMIN_API_KEY is not set" });
    });

    // A8
    it("A8 blocks a non-DEV cloud region with 403 before looking at the token", () => {
      (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY = adminKey();
      (
        env as unknown as { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION?: string }
      ).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = "US";

      // Deliberately no token at all: the cloud gate wins over the token check.
      const outcome = AdminApiAuthService.verifyAdminAuthFromAuthString("");
      expect(outcome).toEqual({
        isAuthorized: false,
        error: "Not accessible on Litefuse Cloud",
      });

      const { res, status, calls } = createRes();
      expect(
        AdminApiAuthService.handleAdminAuth(req(`Bearer ${adminKey()}`), res),
      ).toBe(false);
      expect(status()).toBe(403);
      expect(calls.body).toEqual({
        error: "Not accessible on Litefuse Cloud",
      });
    });

    // A9
    it("A9 allows a correct token on cloud when isAllowedOnLangfuseCloud is set", () => {
      (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY = adminKey();
      (
        env as unknown as { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION?: string }
      ).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = "US";

      const outcome = AdminApiAuthService.verifyAdminAuthFromAuthString(
        adminAuth(),
        { isAllowedOnLangfuseCloud: true },
      );
      expect(outcome.isAuthorized).toBe(true);

      const { res, status, calls } = createRes();
      expect(
        AdminApiAuthService.handleAdminAuth(req(adminAuth()), res, {
          isAllowedOnLangfuseCloud: true,
        }),
      ).toBe(true);
      expect(status()).toBeUndefined();
      expect(calls.jsonCalls).toBe(0);
    });

    // A10
    it("A10 treats the DEV cloud region as local and validates the token normally", () => {
      (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY = adminKey();
      (
        env as unknown as { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION?: string }
      ).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = "DEV";

      expect(
        AdminApiAuthService.verifyAdminAuthFromAuthString(adminAuth())
          .isAuthorized,
      ).toBe(true);
      expect(
        AdminApiAuthService.verifyAdminAuthFromAuthString("Bearer nope"),
      ).toEqual({ isAuthorized: false, error: "Unauthorized: Invalid token" });
    });

    // A11
    it("A11 returns true and leaves res untouched for the correct Bearer token", () => {
      const { res, calls } = createRes();
      expect(AdminApiAuthService.handleAdminAuth(req(adminAuth()), res)).toBe(
        true,
      );
      expect(calls.statusCalls).toBe(0);
      expect(calls.jsonCalls).toBe(0);
      expect(calls.statusCode).toBeUndefined();
      expect(calls.body).toBeUndefined();
    });

    // A12
    it("A12 uses exactly the error key (never message/details) on failures", () => {
      const cases: Array<[string | undefined, unknown]> = [
        [undefined, { error: "Unauthorized: authorization header is missing" }],
        ["Bearer nope", { error: "Unauthorized: Invalid token" }],
      ];
      for (const [authorization, expectedBody] of cases) {
        const { res, calls } = createRes();
        expect(
          AdminApiAuthService.handleAdminAuth(req(authorization), res),
        ).toBe(false);
        expect(Object.keys(calls.body as object)).toEqual(["error"]);
        expect(calls.body).toEqual(expectedBody);
      }
    });

    // A13
    it("A13 returns 401 Invalid token (no throw) for a token of a different length", () => {
      (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY = adminKey();
      // Shorter, longer and equal-length-but-wrong tokens must all be handled
      // without letting `timingSafeEqual` throw on unequal buffers.
      for (const token of [
        "x",
        `${adminKey()}x`,
        "y".repeat(adminKey().length),
      ]) {
        expect(
          AdminApiAuthService.verifyAdminAuthFromAuthString(`Bearer ${token}`),
        ).toEqual({
          isAuthorized: false,
          error: "Unauthorized: Invalid token",
        });
      }
    });
  });

  // =========================================================================
  // B1-B5 — requireInstanceAdmin
  // =========================================================================
  describe("B. requireInstanceAdmin", () => {
    afterEach(() => {
      (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY =
        realAdminApiKey;
      (
        env as unknown as { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION?: string }
      ).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = realCloudRegion;
      if (realLicenseKey === undefined) {
        delete process.env.LITEFUSE_EE_LICENSE_KEY;
      } else {
        process.env.LITEFUSE_EE_LICENSE_KEY = realLicenseKey;
      }
    });

    // B1
    it("B1 returns true and writes nothing when credentials and license are valid", () => {
      process.env.LITEFUSE_EE_LICENSE_KEY = "litefuse_ee_test";
      const { res, calls } = createRes();
      expect(requireInstanceAdmin(req(adminAuth()), res)).toBe(true);
      expect(calls.statusCalls).toBe(0);
      expect(calls.jsonCalls).toBe(0);
    });

    // B2
    it("B2 returns false with 401 for a missing or invalid credential", () => {
      process.env.LITEFUSE_EE_LICENSE_KEY = "litefuse_ee_test";

      const missing = createRes();
      expect(requireInstanceAdmin(req(), missing.res)).toBe(false);
      expect(missing.status()).toBe(401);
      expect(missing.calls.body).toEqual({
        error: "Unauthorized: authorization header is missing",
      });

      const invalid = createRes();
      expect(requireInstanceAdmin(req("Bearer nope"), invalid.res)).toBe(false);
      expect(invalid.status()).toBe(401);
      expect(invalid.calls.body).toEqual({
        error: "Unauthorized: Invalid token",
      });
    });

    // B3
    it("B3 returns false with the entitlement 403 when the license key is unset", () => {
      delete process.env.LITEFUSE_EE_LICENSE_KEY;
      const { res, status, calls } = createRes();
      expect(requireInstanceAdmin(req(adminAuth()), res)).toBe(false);
      expect(status()).toBe(403);
      expect(calls.body).toEqual({
        error: "This feature is not available on your current plan.",
      });
    });

    // B4
    it("B4 returns false with the cloud 403 (credential check wins over the license check)", () => {
      process.env.LITEFUSE_EE_LICENSE_KEY = "litefuse_ee_test";
      (
        env as unknown as { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION?: string }
      ).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = "US";

      const { res, status, calls } = createRes();
      expect(requireInstanceAdmin(req(adminAuth()), res)).toBe(false);
      expect(status()).toBe(403);
      expect(calls.body).toEqual({
        error: "Not accessible on Litefuse Cloud",
      });
    });

    // B5
    it("B5 answers 401 (not 403) when both the header and the license are missing", () => {
      delete process.env.LITEFUSE_EE_LICENSE_KEY;
      const { res, status, calls } = createRes();
      expect(requireInstanceAdmin(req(), res)).toBe(false);
      expect(status()).toBe(401);
      expect(calls.body).toEqual({
        error: "Unauthorized: authorization header is missing",
      });
    });
  });

  // =========================================================================
  // C1-C4 — requireAdminApi (thin forwarding layer)
  // =========================================================================
  describe("C. requireAdminApi", () => {
    const createdOrgIds: string[] = [];
    afterAll(async () => {
      if (createdOrgIds.length > 0) {
        await prisma.organization.deleteMany({
          where: { id: { in: createdOrgIds } },
        });
      }
    });

    const newOrg = async (plan: "Pro" | "Developer") => {
      const org = await prisma.organization.create({
        data: { name: `sso-batch ${unique()}`, cloudConfig: { plan } },
      });
      createdOrgIds.push(org.id);
      return org;
    };
    const newOrgKey = async (orgId: string) => {
      const { createAndAddApiKeysToDb } = await import(
        "@langfuse/shared/src/server"
      );
      return createAndAddApiKeysToDb({
        prisma,
        entityId: orgId,
        scope: "ORGANIZATION",
      });
    };

    // C1
    it("C1 forwards and returns the very same organization scope, writing nothing", async () => {
      const org = await newOrg("Pro");
      const key = await newOrgKey(org.id);
      const { requireAdminApiScope } = await import(
        "@/src/features/public-api/server/adminApiGuard"
      );
      const auth = createBasicAuthHeader(key.publicKey, key.secretKey);

      const direct = await requireAdminApiScope(req(auth), createRes().res);
      const wrapped = createRes();
      const viaWrapper = await requireAdminApi(req(auth), wrapped.res);

      expect(viaWrapper).toEqual(direct);
      expect(viaWrapper).toMatchObject({
        accessLevel: "organization",
        orgId: org.id,
        projectId: null,
      });
      expect(wrapped.calls.statusCalls).toBe(0);
      expect(wrapped.calls.jsonCalls).toBe(0);
    });

    // C2
    it("C2 answers 401 with the auth error when no header is given", async () => {
      const { res, status, calls } = createRes();
      expect(await requireAdminApi(req(), res)).toBeNull();
      expect(status()).toBe(401);
      expect(typeof (calls.body as { error?: unknown }).error).toBe("string");
    });

    // C3
    it("C3 answers the organization-scope 403 for a project-level key", async () => {
      const org = await newOrg("Pro");
      const project = await prisma.project.create({
        data: { name: `sso-batch ${unique()}`, orgId: org.id },
      });
      const { createAndAddApiKeysToDb } = await import(
        "@langfuse/shared/src/server"
      );
      const key = await createAndAddApiKeysToDb({
        prisma,
        entityId: project.id,
        scope: "PROJECT",
      });

      const { res, status, calls } = createRes();
      expect(
        await requireAdminApi(
          req(createBasicAuthHeader(key.publicKey, key.secretKey)),
          res,
        ),
      ).toBeNull();
      expect(status()).toBe(403);
      expect(calls.body).toEqual({
        error:
          "Invalid API key. Organization-scoped API key required for this operation.",
      });
    });

    // C4
    it("C4 answers the plan 403 for an organization plan without admin-api", async () => {
      const org = await newOrg("Developer");
      const key = await newOrgKey(org.id);

      const { res, status, calls } = createRes();
      expect(
        await requireAdminApi(
          req(createBasicAuthHeader(key.publicKey, key.secretKey)),
          res,
        ),
      ).toBeNull();
      expect(status()).toBe(403);
      expect(calls.body).toEqual({
        error: "This feature is not available on your current plan.",
      });
    });
  });

  // =========================================================================
  // G1-G18 + X2 — ssoProviders (module-level)
  // =========================================================================
  //
  // Two constraints shape this block:
  //   * the config cache lives in module scope with a 1-hour TTL, so a case that
  //     needs a cold cache loads its own module instance with
  //     `jest.isolateModulesAsync`;
  //   * `jest.resetModules()` re-evaluates `@langfuse/shared/src/db` and therefore
  //     hands the reloaded module a *different* `prisma` singleton, which makes
  //     `jest.spyOn(prisma, ...)` silently observe nothing. The prisma singleton
  //     in this file is therefore never invalidated: isolation is done with
  //     `isolateModulesAsync`, which does not touch the registry this file
  //     imported from.
  describe("G. ssoProviders", () => {
    type SsoProvidersModule =
      typeof import("@/src/features/enterprise/sso/ssoProviders");

    /**
     * Load a private copy of `ssoProviders` with a fresh (cold) config cache.
     * `isolateModulesAsync` gives the callback its own module registry, so the
     * 1-hour cache cannot leak in either direction while the real prisma
     * singleton stays shared.
     */
    const withFreshSsoProviders = async <T>(
      fn: (mod: SsoProvidersModule) => Promise<T>,
      options: { available: boolean } = { available: true },
    ): Promise<T> => {
      let result!: T;
      await jest.isolateModulesAsync(async () => {
        result = await fn(
          await import("@/src/features/enterprise/sso/ssoProviders"),
        );
      });
      return result;
    };

    // G1, G18
    describe("on an instance without multi-tenant SSO", () => {
      beforeEach(() => setSsoAvailable(false));
      afterEach(() => setSsoAvailable(true));

      // G1
      it("G1 returns the disabled values and never queries the database", async () => {
        const spy = jest.spyOn(prisma, "$transaction");
        try {
          await withFreshSsoProviders(
            async (mod) => {
              await expect(mod.buildSsoProviders()).resolves.toEqual([]);
              await expect(mod.hasSsoConfig()).resolves.toBe(false);
              await expect(
                mod.resolveSsoProviderIdForDomain("acme.test"),
              ).resolves.toBeNull();
              await expect(
                mod.resolveMultiTenantSsoConfig({ providerId: "okta" }),
              ).resolves.toEqual({
                isMultiTenantSsoProvider: false,
                domain: null,
              });
            },
            { available: false },
          );
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });

      // G18
      it("G18 keeps the database untouched across repeated calls", async () => {
        const spy = jest.spyOn(prisma, "$transaction");
        try {
          await withFreshSsoProviders(
            async (mod) => {
              for (let i = 0; i < 3; i += 1) {
                await mod.buildSsoProviders();
                await mod.hasSsoConfig();
                await mod.resolveSsoProviderIdForDomain("acme.test");
                await mod.resolveMultiTenantSsoConfig({ providerId: "okta" });
              }
            },
            { available: false },
          );
          expect(spy).not.toHaveBeenCalled();
          expect(mockLogger.error).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });
    });

    // The shared instance for the remaining cases: the fixtures below are all
    // created before it is loaded, so its entry in the module registry is the
    // one instance every other case sees.
    let mod: SsoProvidersModule;
    let g2: { bare: string; full: string };
    let g3: string;
    let g4: string;
    let g5: { valid: string };
    let g6: string;
    let g7: { bare: string; full: string };
    let g8: { first: string; second: string };
    let g10: { withMethod: string; withoutMethod: string };
    let g11: string;
    let g12: string;
    let g13: {
      customDefault: string;
      customScoped: string;
      jumpDefault: string;
    };
    let g14: string;
    let g16: string;

    beforeAll(async () => {
      setSsoAvailable(true);
      g2 = { bare: `g2bare-${unique()}.test`, full: `g2full-${unique()}.test` };
      g3 = `g3-${unique()}.test`;
      g4 = `g4-${unique()}.test`;
      g5 = { valid: `g5valid-${unique()}.test` };
      g6 = `g6-${unique()}.test`;
      g7 = { bare: `g7bare-${unique()}.test`, full: `g7full-${unique()}.test` };
      g8 = {
        first: `g8first-${unique()}.test`,
        second: `g8second-${unique()}.test`,
      };
      g10 = {
        withMethod: `g10with-${unique()}.test`,
        withoutMethod: `g10without-${unique()}.test`,
      };
      g11 = `g11-${unique()}.test`;
      g12 = `g12-${unique()}.test`;
      g13 = {
        customDefault: `g13custom-${unique()}.test`,
        customScoped: `g13customscope-${unique()}.test`,
        jumpDefault: `g13jump-${unique()}.test`,
      };
      g14 = `g14-${unique()}.test`;
      g16 = `g16-${unique()}.test`;

      await ssoConfig({
        domain: g2.full,
        authProvider: "okta",
        authConfig: {
          ...authConfigWithSecret(),
          issuer: "https://tenant.okta.com",
        },
      });
      await ssoConfig({
        domain: g3,
        authProvider: "okta",
        authConfig: {
          clientId: "g3-client",
          clientSecret: encrypt("g3-plain-secret"),
          issuer: "https://tenant.okta.com",
        },
      });
      await ssoConfig({ domain: g4, authProvider: "okta", authConfig: null });
      await ssoConfig({
        domain: g5.valid,
        authProvider: "okta",
        authConfig: {
          clientId: "g5-client",
          clientSecret: encrypt("g5-secret"),
          issuer: "https://tenant.okta.com",
        },
      });
      await ssoConfig({
        domain: g6,
        authProvider: "okta",
        authConfig: {
          ...authConfigWithSecret(),
          issuer: "https://tenant.okta.com",
        },
      });
      await ssoConfig({
        domain: g7.bare,
        authProvider: "okta",
        authConfig: null,
      });
      await ssoConfig({
        domain: g7.full,
        authProvider: "okta",
        authConfig: {
          ...authConfigWithSecret(),
          issuer: "https://tenant.okta.com",
        },
      });
      await ssoConfig({
        domain: g8.first,
        authProvider: "okta",
        authConfig: {
          ...authConfigWithSecret(),
          issuer: "https://tenant.okta.com",
        },
      });
      await ssoConfig({
        domain: g10.withMethod,
        authProvider: "okta",
        authConfig: {
          ...authConfigWithSecret(),
          issuer: "https://tenant.okta.com",
          tokenEndpointAuthMethod: "client_secret_post",
        },
      });
      await ssoConfig({
        domain: g10.withoutMethod,
        authProvider: "okta",
        authConfig: {
          ...authConfigWithSecret(),
          issuer: "https://tenant.okta.com",
        },
      });
      await ssoConfig({ domain: g11, authProvider: "okta", authConfig: null });
      await ssoConfig({
        domain: g12,
        authProvider: "okta",
        authConfig: {
          ...authConfigWithSecret(),
          issuer: "https://tenant.okta.com",
        },
      });
      await ssoConfig({
        domain: g13.customDefault,
        authProvider: "custom",
        authConfig: {
          clientId: "c",
          clientSecret: encrypt("s"),
          name: "Custom",
          issuer: "https://idp.example.com",
        },
      });
      await ssoConfig({
        domain: g13.customScoped,
        authProvider: "custom",
        authConfig: {
          clientId: "c",
          clientSecret: encrypt("s"),
          name: "Custom",
          issuer: "https://idp.example.com",
          scope: "openid email",
        },
      });
      await ssoConfig({
        domain: g13.jumpDefault,
        authProvider: "jumpcloud",
        authConfig: {
          clientId: "c",
          clientSecret: encrypt("s"),
          issuer: "https://console.jumpcloud.com",
        },
      });
      await ssoConfig({
        domain: g14,
        authProvider: "github-enterprise",
        authConfig: {
          clientId: "c",
          clientSecret: encrypt("s"),
          enterprise: { baseUrl: "https://github.example.com" },
        },
      });
      await ssoConfig({
        domain: g16,
        authProvider: "okta",
        authConfig: {
          ...authConfigWithSecret(),
          issuer: "https://tenant.okta.com",
        },
      });

      mod = await import("@/src/features/enterprise/sso/ssoProviders");
    });

    // G2
    it("G2 reports no configuration for domains that are not configured", async () => {
      const absent = `absent-${unique()}.test`;
      await expect(
        mod.resolveSsoProviderIdForDomain(absent),
      ).resolves.toBeNull();
      await expect(
        mod.resolveMultiTenantSsoConfig({ providerId: `absent-${unique()}` }),
      ).resolves.toEqual({ isMultiTenantSsoProvider: false, domain: null });

      // A domain whose only row has no authConfig still counts as configured,
      // which is the documented inconsistency (spec §16.5, pinned by G4).
      await expect(mod.hasSsoConfig()).resolves.toBe(true);
    });

    // G3
    it("G3 builds one provider per complete config and decrypts the clientSecret", async () => {
      const providers = await mod.buildSsoProviders();
      const mine = providers.filter(
        (p) => providerOptionsId(p) === `${g3}.okta`,
      );
      expect(mine).toHaveLength(1);
      expect(mine[0].options).toMatchObject({
        clientId: "g3-client",
        clientSecret: "g3-plain-secret",
      });
    });

    // G4
    it("G4 treats an auth_config-less row as configured-but-not-buildable", async () => {
      const providers = await mod.buildSsoProviders();
      expect(providers.some((p) => providerOptionsId(p) === `${g4}.okta`)).toBe(
        false,
      );
      await expect(mod.hasSsoConfig()).resolves.toBe(true);
      await expect(mod.resolveSsoProviderIdForDomain(g4)).resolves.toBe("okta");
    });

    // G5 (isolated: the schema-invalid row is created only for this case, so the
    // shared instance is never polluted by it)
    it("G5 skips a schema-invalid row, logs once and keeps serving the valid rows", async () => {
      const invalid = `g5invalid-${unique()}.test`;
      await ssoConfig({
        domain: invalid,
        authProvider: "nope",
        authConfig: { clientId: "x", clientSecret: "y" },
      });

      await withFreshSsoProviders(async (fresh) => {
        const providers = await fresh.buildSsoProviders();
        expect(
          providers.some((p) => providerOptionsId(p) === `${g5.valid}.okta`),
        ).toBe(true);
        await expect(
          fresh.resolveSsoProviderIdForDomain(invalid),
        ).resolves.toBeNull();
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        `Skipping SSO config of domain ${invalid}: invalid schema`,
        expect.anything(),
      );
      expect(mockTraceException).toHaveBeenCalled();
    });

    // G6
    it("G6 matches the domain case-insensitively and misses unknown domains", async () => {
      await expect(
        mod.resolveSsoProviderIdForDomain(g6.toUpperCase()),
      ).resolves.toBe(`${g6}.okta`);
      await expect(
        mod.resolveSsoProviderIdForDomain(`other-${unique()}.test`),
      ).resolves.toBeNull();
      // No trim: a trailing space does not match.
      await expect(
        mod.resolveSsoProviderIdForDomain(`${g6} `),
      ).resolves.toBeNull();
    });

    // G7
    it("G7 returns the bare provider id without authConfig and domain.provider with one", async () => {
      await expect(mod.resolveSsoProviderIdForDomain(g7.bare)).resolves.toBe(
        "okta",
      );
      await expect(mod.resolveSsoProviderIdForDomain(g7.full)).resolves.toBe(
        `${g7.full}.okta`,
      );
    });

    // G8
    it("G8 does not re-read the database inside the TTL", async () => {
      await expect(mod.hasSsoConfig()).resolves.toBe(true);
      await ssoConfig({
        domain: g8.second,
        authProvider: "okta",
        authConfig: null,
      });
      await expect(
        mod.resolveSsoProviderIdForDomain(g8.second),
      ).resolves.toBeNull();
    });

    // G9 (runs after every other G case: it installs a module mock, and a mock
    // is global to the file's registry, so it must not be visible to cases that
    // use the shared prisma. The failing read is injected on the db module
    // rather than spied on, because the isolated copy resolves its own prisma.)
    it("G9 swallows a failed read, answers false and caches the failure", async () => {
      let dbAttempts = 0;
      jest.doMock("@langfuse/shared/src/db", () => {
        const actual = jest.requireActual("@langfuse/shared/src/db");
        return {
          ...actual,
          prisma: {
            ...actual.prisma,
            $transaction: () => {
              dbAttempts += 1;
              return Promise.reject(new Error("database down"));
            },
          },
        };
      });
      try {
        await withFreshSsoProviders(async (fresh) => {
          // The fixtures exist in the database, so "false" can only come from
          // the swallowed read failure (and the fail-open empty cache).
          await expect(fresh.hasSsoConfig()).resolves.toBe(false);
          await expect(fresh.hasSsoConfig()).resolves.toBe(false);
          await expect(
            fresh.resolveSsoProviderIdForDomain(g4),
          ).resolves.toBeNull();
          // One attempt for the whole 60-second retry window.
          expect(dbAttempts).toBe(1);
        });

        expect(mockLogger.error).toHaveBeenCalledWith(
          "Unable to read the SSO configs from the database",
          expect.anything(),
        );
        expect(mockTraceException).toHaveBeenCalled();
      } finally {
        jest.dontMock("@langfuse/shared/src/db");
      }
    });

    // G10
    it("G10 passes tokenEndpointAuthMethod through client.token_endpoint_auth_method", async () => {
      const providers = await mod.buildSsoProviders();
      const withProvider = providers.find(
        (p) => providerOptionsId(p) === `${g10.withMethod}.okta`,
      );
      const withoutProvider = providers.find(
        (p) => providerOptionsId(p) === `${g10.withoutMethod}.okta`,
      );
      expect(
        (withProvider?.options as { client?: unknown } | undefined)?.client,
      ).toEqual({ token_endpoint_auth_method: "client_secret_post" });
      expect(withoutProvider).toBeDefined();
      expect(
        Object.prototype.hasOwnProperty.call(
          withoutProvider?.options,
          "client",
        ),
      ).toBe(false);
    });

    // G11
    it("G11 does not resolve a bare provider id to an authConfig-less row", async () => {
      await expect(
        mod.resolveMultiTenantSsoConfig({ providerId: "okta" }),
      ).resolves.toEqual({ isMultiTenantSsoProvider: false, domain: null });
      expect(g11).toBeTruthy();
    });

    // G12
    it("G12 resolves a domain-qualified provider id and rejects unknown ids", async () => {
      await expect(
        mod.resolveMultiTenantSsoConfig({ providerId: `${g12}.okta` }),
      ).resolves.toEqual({ isMultiTenantSsoProvider: true, domain: g12 });
      await expect(
        mod.resolveMultiTenantSsoConfig({ providerId: `${g12}.google` }),
      ).resolves.toEqual({ isMultiTenantSsoProvider: false, domain: null });
    });

    // G13
    it("G13 defaults the custom/jumpcloud scope to openid email profile", async () => {
      const providers = await mod.buildSsoProviders();
      // The provider object shapes differ between the factories: the built-in
      // and custom ones keep an `options` object, while jumpcloud spreads its
      // options onto the provider itself. The lookup key is `options.id` in all
      // cases (spec §6.3).
      type OAuthish = {
        id?: string;
        options?: {
          id?: string;
          authorization?: { params?: { scope?: string } };
        };
        authorization?: { params?: { scope?: string } };
      };
      const provider = (id: string) =>
        providers.find(
          (candidate) => providerOptionsId(candidate as never) === id,
        ) as OAuthish | undefined;
      const scopeOf = (id: string, where: "options" | "top") => {
        const candidate = provider(id);
        return (
          where === "options"
            ? candidate?.options?.authorization
            : candidate?.authorization
        )?.params?.scope;
      };

      // custom: the scope the application passes reaches the options object.
      expect(scopeOf(`${g13.customDefault}.custom`, "options")).toBe(
        "openid email profile",
      );
      expect(scopeOf(`${g13.customScoped}.custom`, "options")).toBe(
        "openid email",
      );
      // jumpcloud: the factory spreads its options, so the passed scope lands on
      // the provider object's own `authorization` (and replaces the default).
      expect(scopeOf(`${g13.jumpDefault}.jumpcloud`, "top")).toBe(
        "openid email profile",
      );
    });

    // G14
    it("G14 builds the github-enterprise authorization URL from enterprise.baseUrl", async () => {
      const provider = (await mod.buildSsoProviders()).find(
        (p) => providerOptionsId(p) === `${g14}.github-enterprise`,
      );
      expect(provider).toBeDefined();
      expect(
        (
          (provider as unknown as { authorization: { url: string } })
            .authorization.url satisfies string
        ).startsWith("https://github.example.com"),
      ).toBe(true);
    });

    // G15 (isolated: the bad ciphertext row is created only for this case, so
    // it cannot make the shared instance's buildSsoProviders throw)
    it("G15 lets buildSsoProviders throw on a bad ciphertext while the id lookup still resolves", async () => {
      const domain = `g15-${unique()}.test`;
      await ssoConfig({
        domain,
        authProvider: "okta",
        authConfig: {
          clientId: "c",
          clientSecret: "not-a-cipher",
          issuer: "https://tenant.okta.com",
        },
      });

      await withFreshSsoProviders(async (fresh) => {
        await expect(fresh.buildSsoProviders()).rejects.toThrow();
        await expect(fresh.resolveSsoProviderIdForDomain(domain)).resolves.toBe(
          `${domain}.okta`,
        );
        // hasSsoConfig only counts rows; it does not decrypt.
        await expect(fresh.hasSsoConfig()).resolves.toBe(true);
      });
    });

    // G16
    it("G16 does not leak createdAt/updatedAt onto provider objects", async () => {
      const provider = (await mod.buildSsoProviders()).find(
        (p) => providerOptionsId(p) === `${g16}.okta`,
      );
      expect(provider?.options).toBeDefined();
      expect(
        Object.prototype.hasOwnProperty.call(provider?.options, "createdAt"),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(provider?.options, "updatedAt"),
      ).toBe(false);
    });

    // G17 (isolated: needs a cold cache; module mock scoped like G9)
    it("G17 reads every row without where/select/orderBy inside the pinned transaction", async () => {
      let txOptions: unknown;
      let findManyArgs: unknown[] | undefined;
      jest.doMock("@langfuse/shared/src/db", () => {
        const actual = jest.requireActual("@langfuse/shared/src/db");
        return {
          ...actual,
          prisma: {
            ...actual.prisma,
            $transaction: (
              callback: (tx: TxDelegate) => Promise<unknown[]>,
              options: unknown,
            ) => {
              txOptions = options;
              return callback({
                ssoConfig: {
                  findMany: (...args: unknown[]) => {
                    findManyArgs = args;
                    return Promise.resolve([]);
                  },
                },
              });
            },
          },
        };
      });
      try {
        await withFreshSsoProviders(async (fresh) => {
          await fresh.hasSsoConfig();
        });
        expect(txOptions).toEqual({ maxWait: 5000, timeout: 5000 });
        // No where/select/orderBy: the production callback passes no arguments.
        expect(findManyArgs).toEqual([]);
      } finally {
        jest.dontMock("@langfuse/shared/src/db");
      }
    });

    // X2 (mandatory) — the exported surface the MIT gateway calls by name.
    it("X2 exports exactly the four gateway functions, all callable", async () => {
      expect(Object.keys(mod).sort()).toEqual([
        "buildSsoProviders",
        "hasSsoConfig",
        "resolveMultiTenantSsoConfig",
        "resolveSsoProviderIdForDomain",
      ]);
      expect(typeof mod.buildSsoProviders).toBe("function");
      expect(typeof mod.hasSsoConfig).toBe("function");
      expect(typeof mod.resolveSsoProviderIdForDomain).toBe("function");
      expect(typeof mod.resolveMultiTenantSsoConfig).toBe("function");

      // Callable with the gateway's exact call shapes. A domain that is not
      // configured keeps this cheap and observable.
      const absent = `x2-${unique()}.test`;
      expect(Array.isArray(await mod.buildSsoProviders())).toBe(true);
      expect(typeof (await mod.hasSsoConfig())).toBe("boolean");
      await expect(
        mod.resolveSsoProviderIdForDomain(absent),
      ).resolves.toBeNull();
      await expect(
        mod.resolveMultiTenantSsoConfig({ providerId: `${absent}.okta` }),
      ).resolves.toEqual({
        isMultiTenantSsoProvider: false,
        domain: null,
      });

      // The gateway's dynamic-import specifier must stay resolvable, or the
      // licensed-instance path would fail closed for the wrong reason.
      await expect(
        import("@/src/features/enterprise/sso/ssoProviders"),
      ).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // E1-E15 — createSsoConfig (direct handler calls)
  // =========================================================================
  describe("E. createSsoConfig", () => {
    const createSsoConfig = () =>
      import("@/src/features/enterprise/sso/createSsoConfig");
    beforeEach(() => setSsoAvailable(true));
    afterEach(() => {
      setSsoAvailable(true);
      (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY =
        realAdminApiKey;
      (env as unknown as { ENCRYPTION_KEY?: string }).ENCRYPTION_KEY =
        realEncryptionKey;
    });

    // E1
    it("E1 answers 403 before anything else when multi-tenant SSO is unavailable", async () => {
      setSsoAvailable(false);
      const mod = await createSsoConfig();
      const { res, status, calls } = createRes();
      await mod.createSsoConfig(bodyReq("POST", {}), res);
      expect(status()).toBe(403);
      expect(calls.body).toEqual({
        error: "Multi-tenant SSO is not enabled on this instance",
      });
    });

    // E2
    it("E2 answers 405 Method Not Allowed for a non-POST method", async () => {
      const mod = await createSsoConfig();
      const { res, status, calls } = createRes();
      await mod.createSsoConfig(bodyReq("GET"), res);
      expect(status()).toBe(405);
      expect(calls.body).toEqual({ error: "Method Not Allowed" });
    });

    // E3
    it("E3 puts the availability check before the method check", async () => {
      setSsoAvailable(false);
      const mod = await createSsoConfig();
      const { res, status, calls } = createRes();
      await mod.createSsoConfig(bodyReq("GET"), res);
      expect(status()).toBe(403);
      expect(calls.body).toEqual({
        error: "Multi-tenant SSO is not enabled on this instance",
      });
    });

    // E4
    it("E4 answers 500 ADMIN_API_KEY is not set before authentication", async () => {
      (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY = undefined;
      const mod = await createSsoConfig();
      const { res, status, calls } = createRes();
      await mod.createSsoConfig(bodyReq("POST", {}, adminAuth()), res);
      expect(status()).toBe(500);
      expect(calls.body).toEqual({ error: "ADMIN_API_KEY is not set" });
    });

    // E5
    it("E5 puts the method check before the environment checks", async () => {
      (env as unknown as { ADMIN_API_KEY?: string }).ADMIN_API_KEY = undefined;
      const mod = await createSsoConfig();
      const { res, status, calls } = createRes();
      await mod.createSsoConfig(bodyReq("GET", {}, adminAuth()), res);
      expect(status()).toBe(405);
      expect(calls.body).toEqual({ error: "Method Not Allowed" });
    });

    // E6
    it("E6 answers 401 when no Authorization header is present", async () => {
      const mod = await createSsoConfig();
      const { res, status, calls } = createRes();
      await mod.createSsoConfig(bodyReq("POST", {}), res);
      expect(status()).toBe(401);
      expect(calls.body).toEqual({
        error: "Unauthorized: authorization header is missing",
      });
    });

    // E7
    it("E7 answers 401 for a wrong Bearer token", async () => {
      const mod = await createSsoConfig();
      const { res, status, calls } = createRes();
      await mod.createSsoConfig(
        bodyReq("POST", {}, "Bearer invalid-admin-key"),
        res,
      );
      expect(status()).toBe(401);
      expect(calls.body).toEqual({ error: "Unauthorized: Invalid token" });
    });

    // E8
    it("E8 answers 500 ENCRYPTION_KEY environment variable is missing before authentication", async () => {
      (env as unknown as { ENCRYPTION_KEY?: string }).ENCRYPTION_KEY =
        undefined;
      const mod = await createSsoConfig();
      const { res, status, calls } = createRes();
      await mod.createSsoConfig(bodyReq("POST", {}, adminAuth()), res);
      expect(status()).toBe(500);
      expect(calls.body).toEqual({
        error: "ENCRYPTION_KEY environment variable is missing",
      });
    });

    // E9 (HTTP-side shape is asserted in the R describe; here the same parse
    // branch is asserted directly so it also runs without a dev server).
    it("E9 answers 400 with the parsed ZodError as the error value", async () => {
      const mod = await createSsoConfig();
      const cases: Array<[unknown, string]> = [
        [
          { domain: "Ok.com", authProvider: "google", authConfig: {} },
          "Domains must be written in lowercase",
        ],
        [
          { domain: "ok.test", authProvider: "nope", authConfig: {} },
          "No matching discriminator",
        ],
        [{ domain: "ok.test", authConfig: {} }, "No matching discriminator"],
      ];

      for (const [body, expectedMessage] of cases) {
        const { res, status, calls } = createRes();
        await mod.createSsoConfig(bodyReq("POST", body, adminAuth()), res);
        expect(status()).toBe(400);
        const response = calls.body as {
          error?: { name?: string; message?: string };
        };
        // Exactly `error`: no `details`, no issue array.
        expect(Object.keys(response)).toEqual(["error"]);
        expect(response.error?.name).toBe("ZodError");
        expect(response.error?.message).toContain(expectedMessage);
      }
    });

    // E10
    it("E10 stores the row and answers 201 with only a message", async () => {
      const domain = `e10-${unique()}.test`;
      createdDomains.push(domain);
      const mod = await createSsoConfig();
      const { res, status, calls } = createRes();
      await mod.createSsoConfig(
        bodyReq(
          "POST",
          {
            domain,
            authProvider: "okta",
            authConfig: {
              clientId: "e10-client",
              clientSecret: "e10-secret",
              issuer: "https://tenant.okta.com",
            },
          },
          adminAuth(),
        ),
        res,
      );
      expect(status()).toBe(201);
      expect(calls.body).toEqual({
        message: "SSO configuration created successfully",
      });

      const row = await prisma.ssoConfig.findUnique({ where: { domain } });
      expect(row).not.toBeNull();
      expect(row?.authProvider).toBe("okta");
    });

    // E11
    it("E11 encrypts only clientSecret and keeps the other fields in clear text", async () => {
      const domain = `e11-${unique()}.test`;
      createdDomains.push(domain);
      const mod = await createSsoConfig();
      const { res, status } = createRes();
      await mod.createSsoConfig(
        bodyReq(
          "POST",
          {
            domain,
            authProvider: "okta",
            authConfig: {
              clientId: "e11-client",
              clientSecret: "e11-plain-secret",
              issuer: "https://tenant.okta.com",
            },
          },
          adminAuth(),
        ),
        res,
      );
      expect(status()).toBe(201);

      const row = await prisma.ssoConfig.findUniqueOrThrow({
        where: { domain },
      });
      const authConfig = row.authConfig as Record<string, unknown>;
      expect(authConfig.clientId).toBe("e11-client");
      expect(authConfig.issuer).toBe("https://tenant.okta.com");
      expect(authConfig.clientSecret).not.toBe("e11-plain-secret");
      expect(typeof authConfig.clientSecret).toBe("string");
      expect((authConfig.clientSecret as string).split(":")).toHaveLength(3);
      expect(decrypt(authConfig.clientSecret as string)).toBe(
        "e11-plain-secret",
      );
    });

    // E12
    it("E12 answers 409 for a duplicate domain and leaves one row", async () => {
      const domain = `e12-${unique()}.test`;
      createdDomains.push(domain);
      const mod = await createSsoConfig();
      const create = () =>
        mod.createSsoConfig(
          bodyReq(
            "POST",
            {
              domain,
              authProvider: "okta",
              authConfig: {
                clientId: "c",
                clientSecret: "s",
                issuer: "https://tenant.okta.com",
              },
            },
            adminAuth(),
          ),
          createRes().res,
        );

      await create();
      const second = createRes();
      await mod.createSsoConfig(
        bodyReq(
          "POST",
          {
            domain,
            authProvider: "okta",
            authConfig: {
              clientId: "c",
              clientSecret: "s",
              issuer: "https://tenant.okta.com",
            },
          },
          adminAuth(),
        ),
        second.res,
      );
      expect(second.status()).toBe(409);
      expect(second.calls.body).toEqual({
        error: `Domain ${domain} already has an SSO configuration`,
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Rejected a duplicate SSO configuration",
        { domain },
      );
      expect(await prisma.ssoConfig.count({ where: { domain } })).toBe(1);
    });

    // E13
    it("E13 stores auth_config NULL when authConfig is missing or null", async () => {
      const missing = `e13missing-${unique()}.test`;
      const nulled = `e13null-${unique()}.test`;
      createdDomains.push(missing, nulled);
      const mod = await createSsoConfig();

      await mod.createSsoConfig(
        bodyReq("POST", { domain: missing, authProvider: "okta" }, adminAuth()),
        createRes().res,
      );
      await mod.createSsoConfig(
        bodyReq(
          "POST",
          { domain: nulled, authProvider: "okta", authConfig: null },
          adminAuth(),
        ),
        createRes().res,
      );

      for (const domain of [missing, nulled]) {
        const row = await prisma.ssoConfig.findUniqueOrThrow({
          where: { domain },
        });
        expect(row.authConfig).toBeNull();
      }
    });

    // E14
    it("E14 persists the default allowDangerousEmailAccountLinking: false", async () => {
      const domain = `e14-${unique()}.test`;
      createdDomains.push(domain);
      const mod = await createSsoConfig();
      await mod.createSsoConfig(
        bodyReq(
          "POST",
          {
            domain,
            authProvider: "okta",
            authConfig: {
              clientId: "c",
              clientSecret: "s",
              issuer: "https://tenant.okta.com",
            },
          },
          adminAuth(),
        ),
        createRes().res,
      );

      const row = await prisma.ssoConfig.findUniqueOrThrow({
        where: { domain },
      });
      expect(
        (row.authConfig as Record<string, unknown>)
          .allowDangerousEmailAccountLinking,
      ).toBe(false);
    });

    // E15
    it("E15 accepts a correct token on a cloud region (isAllowedOnLangfuseCloud)", async () => {
      (
        env as unknown as { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION?: string }
      ).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = "US";
      const domain = `e15-${unique()}.test`;
      createdDomains.push(domain);
      try {
        const mod = await createSsoConfig();
        const { res, status, calls } = createRes();
        await mod.createSsoConfig(bodyReq("POST", {}), res);
        // No header on a cloud region → the ordinary missing-header 401, i.e.
        // the cloud gate did NOT fire ("Not accessible on Litefuse Cloud").
        expect(status()).toBe(401);
        expect(calls.body).toEqual({
          error: "Unauthorized: authorization header is missing",
        });

        const created = createRes();
        await mod.createSsoConfig(
          bodyReq(
            "POST",
            {
              domain,
              authProvider: "okta",
              authConfig: {
                clientId: "c",
                clientSecret: "s",
                issuer: "https://tenant.okta.com",
              },
            },
            adminAuth(),
          ),
          created.res,
        );
        expect(created.status()).toBe(201);
      } finally {
        (
          env as unknown as { NEXT_PUBLIC_LITEFUSE_CLOUD_REGION?: string }
        ).NEXT_PUBLIC_LITEFUSE_CLOUD_REGION = realCloudRegion;
      }
    });
  });

  // =========================================================================
  // F1-F7 — check-sso handler (direct calls; the domain lookup is uncached in
  // a freshly loaded module, which the dev server cannot guarantee)
  // =========================================================================
  describe("F. /api/auth/check-sso handler", () => {
    type CheckSsoHandler = typeof import("@/src/pages/api/auth/check-sso");

    /**
     * Load the handler with a fresh enterprise module, i.e. a cold SSO config
     * cache, and run `fn` against it. `check-sso` itself is stateless; the cache
     * lives in the module it imports, so the whole import chain has to run
     * inside the isolated registry.
     */
    const withFreshHandler = async <T>(
      fn: (mod: CheckSsoHandler) => Promise<T>,
    ): Promise<T> => {
      let result!: T;
      await jest.isolateModulesAsync(async () => {
        result = await fn(await import("@/src/pages/api/auth/check-sso"));
      });
      return result;
    };
    beforeEach(() => setSsoAvailable(true));
    afterEach(() => setSsoAvailable(true));

    // F1
    it("F1 answers 405 with the message key for a non-POST method", async () => {
      await withFreshHandler(async (mod) => {
        const { res, status, calls } = createRes();
        await mod.default(bodyReq("GET"), res);
        expect(status()).toBe(405);
        expect(calls.body).toEqual({ message: "Method not allowed" });
      });
    });

    // F2
    it("F2 answers 400 Invalid request body for a body without a domain", async () => {
      await withFreshHandler(async (mod) => {
        for (const body of [{}, { domain: "" }, { domain: 42 }, undefined]) {
          const { res, status, calls } = createRes();
          await mod.default(bodyReq("POST", body), res);
          expect({ body, status: status(), response: calls.body }).toEqual({
            body,
            status: 400,
            response: { message: "Invalid request body" },
          });
        }
      });
    });

    // F4
    it("F4 answers 404 No SSO provider configured for an unknown domain", async () => {
      await withFreshHandler(async (mod) => {
        const { res, status, calls } = createRes();
        await mod.default(
          bodyReq("POST", { domain: `absent-${unique()}.test` }),
          res,
        );
        expect(status()).toBe(404);
        expect(calls.body).toEqual({ message: "No SSO provider configured" });
      });
    });

    // F5
    it("F5 answers 200 with the domain-qualified provider id for a configured domain", async () => {
      const domain = `f5-${unique()}.test`;
      await ssoConfig({
        domain,
        authProvider: "okta",
        authConfig: {
          ...authConfigWithSecret(),
          issuer: "https://tenant.okta.com",
        },
      });

      await withFreshHandler(async (mod) => {
        const { res, status, calls } = createRes();
        await mod.default(
          bodyReq("POST", { domain: domain.toUpperCase() }),
          res,
        );
        expect(status()).toBe(200);
        expect(calls.body).toEqual({ providerId: `${domain}.okta` });
      });
    });

    // F6
    it("F6 answers 200 with the bare provider id when auth_config is NULL", async () => {
      const domain = `f6-${unique()}.test`;
      await ssoConfig({ domain, authProvider: "okta", authConfig: null });

      await withFreshHandler(async (mod) => {
        const { res, status, calls } = createRes();
        await mod.default(bodyReq("POST", { domain }), res);
        expect(status()).toBe(200);
        expect(calls.body).toEqual({ providerId: "okta" });
      });
    });

    // F7
    it("F7 answers 404 (not 403) on an unlicensed instance", async () => {
      setSsoAvailable(false);
      await withFreshHandler(async (mod) => {
        const { res, status, calls } = createRes();
        await mod.default(bodyReq("POST", { domain: "acme.test" }), res);
        expect(status()).toBe(404);
        expect(calls.body).toEqual({ message: "No SSO provider configured" });
      });
    });
  });

  // =========================================================================
  // R1/R2 + E9 — HTTP route shells on the dev server (optional)
  // =========================================================================
  describe("R. HTTP route shells", () => {
    let serverUp = false;
    beforeAll(async () => {
      try {
        const res = await fetch("http://localhost:3000/api/auth/check-sso", {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        serverUp = res.status > 0;
      } catch {
        serverUp = false;
      }
      if (!serverUp) {
        // eslint-disable-next-line no-console
        console.warn(
          "auth-sso-api.servertest: no dev server on :3000 — skipping the three HTTP cases. " +
            "The module-level cases above already cover the same branches.",
        );
      }
    });
    const itHttp = (name: string, fn: () => Promise<void>) =>
      it(name, async () => {
        if (!serverUp) return;
        await fn();
      });

    // R1
    itHttp(
      "R1 GET /api/auth/add-sso-config answers 405 Method Not Allowed",
      async () => {
        const { status, body } = await makeAPICall(
          "GET",
          "/api/auth/add-sso-config",
          undefined,
          adminAuth(),
        );
        expect({ status, body }).toEqual({
          status: 405,
          body: { error: "Method Not Allowed" },
        });
      },
    );

    // R2 (part 1) — the shell forwards to createSsoConfig without adding logic.
    itHttp(
      "R2 POST /api/auth/add-sso-config answers 401 without a header",
      async () => {
        const res = await fetch(
          "http://localhost:3000/api/auth/add-sso-config",
          {
            method: "POST",
            headers: { Accept: "application/json" },
          },
        );
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({
          error: "Unauthorized: authorization header is missing",
        });
      },
    );

    itHttp(
      "R2 POST /api/auth/add-sso-config answers 401 for a wrong Bearer token",
      async () => {
        const res = await makeAPICall(
          "POST",
          "/api/auth/add-sso-config",
          {},
          "Bearer invalid-admin-key",
        );
        expect(res).toEqual({
          status: 401,
          body: { error: "Unauthorized: Invalid token" },
        });
      },
    );

    // E9 + §16.19 — the 400 body is the serialised ZodError, not details/issues.
    itHttp(
      "E9 POST with an invalid body answers 400 with { error: { name: ZodError, message } }",
      async () => {
        const uppercase = await makeAPICall(
          "POST",
          "/api/auth/add-sso-config",
          { domain: "Ok.com", authProvider: "google", authConfig: {} },
          adminAuth(),
        );
        expect(uppercase.status).toBe(400);
        const uppercaseBody = uppercase.body as {
          error?: { name?: string; message?: string };
          details?: unknown;
        };
        expect(Object.keys(uppercaseBody)).toEqual(["error"]);
        expect(uppercaseBody.details).toBeUndefined();
        expect(uppercaseBody.error?.name).toBe("ZodError");
        expect(uppercaseBody.error?.message).toContain(
          "Domains must be written in lowercase",
        );

        const unknownProvider = await makeAPICall(
          "POST",
          "/api/auth/add-sso-config",
          { domain: "ok.test", authProvider: "nope", authConfig: {} },
          adminAuth(),
        );
        expect(unknownProvider.status).toBe(400);
        const unknownBody = unknownProvider.body as {
          error?: { name?: string; message?: string };
        };
        expect(unknownBody.error?.name).toBe("ZodError");
        expect(unknownBody.error?.message).toContain(
          "No matching discriminator",
        );
      },
    );

    // F1/F2 over HTTP as well: the 405/400 branches are cache-independent.
    itHttp(
      "F1/F2 GET and an invalid body are rejected before any lookup",
      async () => {
        const get = await makeAPICall("GET", "/api/auth/check-sso");
        expect(get).toEqual({
          status: 405,
          body: { message: "Method not allowed" },
        });

        const empty = await makeAPICall("POST", "/api/auth/check-sso", {});
        expect(empty).toEqual({
          status: 400,
          body: { message: "Invalid request body" },
        });

        const emptyDomain = await makeAPICall("POST", "/api/auth/check-sso", {
          domain: "",
        });
        expect(emptyDomain).toEqual({
          status: 400,
          body: { message: "Invalid request body" },
        });
      },
    );

    // R2 (part 2) — the wrapper carries zero logic: the HTTP status/body for a
    // legal body equals the direct call's. The domain is unique per run so the
    // shared dev-server database stays clean (the row is removed in afterAll).
    itHttp(
      "R2 HTTP and direct calls agree on the 201 response for a legal body",
      async () => {
        const httpDomain = `r2http-${unique()}.test`;
        const directDomain = `r2direct-${unique()}.test`;
        createdDomains.push(httpDomain, directDomain);
        const payload = (domain: string) => ({
          domain,
          authProvider: "okta",
          authConfig: {
            clientId: "r2-client",
            clientSecret: "r2-secret",
            issuer: "https://tenant.okta.com",
          },
        });

        const overHttp = await makeAPICall(
          "POST",
          "/api/auth/add-sso-config",
          payload(httpDomain),
          adminAuth(),
        );
        expect(overHttp).toEqual({
          status: 201,
          body: { message: "SSO configuration created successfully" },
        });

        const mod = await import(
          "@/src/features/enterprise/sso/createSsoConfig"
        );
        const direct = createRes();
        await mod.createSsoConfig(
          bodyReq("POST", payload(directDomain), adminAuth()),
          direct.res,
        );
        expect({ status: direct.status(), body: direct.calls.body }).toEqual({
          status: overHttp.status,
          body: overHttp.body,
        });

        expect(
          await prisma.ssoConfig.count({ where: { domain: httpDomain } }),
        ).toBe(1);
        expect(
          await prisma.ssoConfig.count({ where: { domain: directDomain } }),
        ).toBe(1);
      },
    );
  });
});
