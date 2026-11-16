/**
 * Interoperability tests for the community↔enterprise SSO gateway (batch 3a,
 * case X2 of docs/ee-independence/03-auth-sso/spec.md §12.11).
 *
 * Author: Select DB — the party that has read the original implementations and
 * therefore owns the specification, the tests and the gates. The implementation
 * is written by Zhang Mo, who never sees the originals; the role convention is
 * documented in docs/ee-independence/README.md.
 *
 * WHY THIS FILE EXISTS
 * `web/src/features/auth/sso/enterpriseSso.ts` (MIT) resolves the enterprise
 * implementation with a *dynamic* `import()` and then calls four exports by
 * name. A rename in `ssoProviders.ts` is invisible to `tsgo` and to the
 * existing `enterpriseSso.clienttest.ts` (it mocks the enterprise module), so
 * the contract needs a test that pins both sides:
 *
 *   1. the gateway exports exactly the four community-facing functions and
 *      forwards to the enterprise module's four functions, one name at a time
 *      (a rename on either side turns this red);
 *   2. the licensed-instance load failure still fails CLOSED (X4) and a later
 *      call retries instead of caching "no SSO".
 *
 * WHERE THE REAL-MODULE EXPORT SURFACE IS ASSERTED
 * The mandatory part of X2 — import the REAL
 * `@/src/features/enterprise/sso/ssoProviders` and assert its exported surface —
 * lives in `src/__tests__/server/auth-sso-api.servertest.ts` ("X2 exports exactly
 * the four gateway functions"). It cannot run here: this is the jsdom (client)
 * project, and importing the real module pulls in the shared server barrel,
 * which needs Node-only globals that jsdom does not provide (the first failure
 * is `TextDecoder`, then `ReadableStream`, then undici's `MessagePort`). Adding
 * those polyfills to a test file would mutate the environment for every other
 * client test, so the real-module assertion is kept where it already works and
 * this file pins the gateway half of the same contract.
 *
 * The file is deliberately co-located with the gateway it characterises.
 */

const AVAILABILITY = "./isMultiTenantSsoAvailable";
const ENTERPRISE_SSO = "../../enterprise/sso/ssoProviders";
const SHARED_SERVER = "@langfuse/shared/src/server";

type Gateway = typeof import("@/src/features/auth/sso/enterpriseSso");
type EnterpriseSso =
  typeof import("@/src/features/enterprise/sso/ssoProviders");

const loadGateway = (): Promise<Gateway> =>
  import("@/src/features/auth/sso/enterpriseSso");

describe("enterprise SSO gateway ↔ ssoProviders interoperability (X2/X4)", () => {
  afterEach(() => {
    jest.resetModules();
  });

  // X2 (gateway side): the four names the gateway reaches for, called one by one.
  it("X2 forwards each of the four enterprise exports under the same name", async () => {
    jest.resetModules();
    jest.doMock(SHARED_SERVER, () => ({
      logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() },
      traceException: jest.fn(),
    }));
    jest.doMock(AVAILABILITY, () => ({ isMultiTenantSsoAvailable: true }));
    jest.doMock(ENTERPRISE_SSO, () => ({
      buildSsoProviders: jest.fn(async () => []),
      hasSsoConfig: jest.fn(async () => true),
      resolveSsoProviderIdForDomain: jest.fn(async () => "acme.test.okta"),
      resolveMultiTenantSsoConfig: jest.fn(async () => ({
        isMultiTenantSsoProvider: true as const,
        domain: "acme.test",
      })),
    }));

    const gateway = await loadGateway();
    const enterprise = (await import(
      ENTERPRISE_SSO
    )) as unknown as EnterpriseSso;

    // The community-facing functions of the gateway itself (the names community
    // call sites such as server/auth.ts import). The gateway also exports the
    // error class, so this asserts the four are present as functions rather than
    // an exact key set.
    for (const name of [
      "buildSsoProviders",
      "hasSsoConfig",
      "resolveMultiTenantSsoConfig",
      "resolveSsoProviderIdForDomain",
    ] as const) {
      expect({ name, type: typeof gateway[name] }).toEqual({
        name,
        type: "function",
      });
    }

    await expect(gateway.buildSsoProviders()).resolves.toEqual([]);
    expect(enterprise.buildSsoProviders).toHaveBeenCalledTimes(1);

    await expect(gateway.hasSsoConfig()).resolves.toBe(true);
    expect(enterprise.hasSsoConfig).toHaveBeenCalledTimes(1);

    await expect(
      gateway.resolveSsoProviderIdForDomain("acme.test"),
    ).resolves.toBe("acme.test.okta");
    expect(enterprise.resolveSsoProviderIdForDomain).toHaveBeenCalledWith(
      "acme.test",
    );

    await expect(
      gateway.resolveMultiTenantSsoConfig({ providerId: "acme.test.okta" }),
    ).resolves.toEqual({
      isMultiTenantSsoProvider: true,
      domain: "acme.test",
    });
    expect(enterprise.resolveMultiTenantSsoConfig).toHaveBeenCalledWith({
      providerId: "acme.test.okta",
    });
  });

  // X4: fail CLOSED when a licensed instance cannot load the implementation.
  it("X4 rejects every call when a licensed instance cannot load the implementation", async () => {
    jest.resetModules();
    jest.doMock(SHARED_SERVER, () => ({
      logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() },
      traceException: jest.fn(),
    }));
    jest.doMock(AVAILABILITY, () => ({ isMultiTenantSsoAvailable: true }));
    jest.doMock(ENTERPRISE_SSO, () => {
      throw new Error("chunk load failed");
    });

    const gateway = await loadGateway();

    await expect(gateway.buildSsoProviders()).rejects.toThrow(
      /could not be loaded/,
    );
    await expect(gateway.hasSsoConfig()).rejects.toThrow(/could not be loaded/);
    await expect(
      gateway.resolveSsoProviderIdForDomain("acme.com"),
    ).rejects.toThrow(/could not be loaded/);
    await expect(
      gateway.resolveMultiTenantSsoConfig({ providerId: "okta" }),
    ).rejects.toThrow(/could not be loaded/);
  });

  // X4 (not cached): a later call retries the import.
  it("X4 retries the import instead of caching the load failure", async () => {
    jest.resetModules();
    jest.doMock(SHARED_SERVER, () => ({
      logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() },
      traceException: jest.fn(),
    }));
    jest.doMock(AVAILABILITY, () => ({ isMultiTenantSsoAvailable: true }));

    let attempts = 0;
    jest.doMock(ENTERPRISE_SSO, () => {
      attempts += 1;
      if (attempts === 1) throw new Error("first load failed");
      return {
        buildSsoProviders: async () => [],
        hasSsoConfig: async () => true,
        resolveSsoProviderIdForDomain: async () => "okta",
        resolveMultiTenantSsoConfig: async () => ({
          isMultiTenantSsoProvider: false as const,
          domain: null,
        }),
      };
    });

    const gateway = await loadGateway();

    await expect(
      gateway.resolveSsoProviderIdForDomain("acme.com"),
    ).rejects.toThrow(/could not be loaded/);
    await expect(
      gateway.resolveSsoProviderIdForDomain("acme.com"),
    ).resolves.toBe("okta");
    expect(attempts).toBe(2);
  });

  // X4 (disabled): an unlicensed instance reports the feature as off and never
  // evaluates the enterprise module.
  it("reports the feature as disabled, without loading it, when the instance is unlicensed", async () => {
    jest.resetModules();
    jest.doMock(SHARED_SERVER, () => ({
      logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() },
      traceException: jest.fn(),
    }));
    jest.doMock(AVAILABILITY, () => ({ isMultiTenantSsoAvailable: false }));
    const enterpriseFactory = jest.fn(() => ({}));
    jest.doMock(ENTERPRISE_SSO, enterpriseFactory);

    const gateway = await loadGateway();

    await expect(gateway.buildSsoProviders()).resolves.toEqual([]);
    await expect(gateway.hasSsoConfig()).resolves.toBe(false);
    await expect(
      gateway.resolveSsoProviderIdForDomain("acme.com"),
    ).resolves.toBeNull();
    await expect(
      gateway.resolveMultiTenantSsoConfig({ providerId: "okta" }),
    ).resolves.toEqual({ isMultiTenantSsoProvider: false, domain: null });
    expect(enterpriseFactory).not.toHaveBeenCalled();
  });
});

// Marks this file as a module: without it, its top-level `type Gateway` is a global
// declaration and collides with the identical one in enterpriseSso.clienttest.ts
export {};
