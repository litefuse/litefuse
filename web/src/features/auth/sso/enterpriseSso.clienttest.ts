/**
 * Regression tests for the community↔enterprise SSO gateway.
 *
 * The gateway exists so that community code never imports licensed (ANNEX A)
 * material at module scope; see the file header of `enterpriseSso.ts`. These
 * tests pin the two halves of the contract that matter for sign-in security:
 *
 *   1. a licensed instance whose implementation fails to load must FAIL CLOSED —
 *      the enforcement call sites in `server/auth.ts` treat `null` as "this
 *      domain has no mandatory SSO", so a load failure must never produce it;
 *   2. the load failure must not be cached as "this instance has no SSO".
 *
 * and the unaffected case: an unlicensed instance reports the feature as
 * disabled without ever touching the enterprise module.
 */

type Gateway = typeof import("@/src/features/auth/sso/enterpriseSso");

// `jest.doMock` resolves its specifier through the plain jest resolver, which
// does not know the `@/` alias this repository uses for imports, so the two
// local modules are addressed relatively. They still register the same resolved
// files that the module under test imports via `@/src/...`.
const AVAILABILITY = "./isMultiTenantSsoAvailable";
const ENTERPRISE_SSO = "../../enterprise/sso/ssoProviders";
const SHARED_SERVER = "@langfuse/shared/src/server";

const mockSharedServer = () =>
  jest.doMock(SHARED_SERVER, () => ({
    logger: { error: jest.fn(), info: jest.fn(), debug: jest.fn() },
    traceException: jest.fn(),
  }));

const loadGateway = (): Promise<Gateway> =>
  import("@/src/features/auth/sso/enterpriseSso");

describe("enterprise SSO gateway", () => {
  // Each test registers all three mocks itself after `resetModules()`, so no
  // per-test cleanup is needed (and `jest.dontMock` cannot resolve the `@/` alias
  // used by the module under test).
  afterEach(() => {
    jest.resetModules();
  });

  it("fails closed when a licensed instance cannot load the implementation", async () => {
    jest.resetModules();
    mockSharedServer();
    jest.doMock(AVAILABILITY, () => ({ isMultiTenantSsoAvailable: true }));
    // A missing chunk / module-initialisation failure: the import rejects.
    jest.doMock(ENTERPRISE_SSO, () => {
      throw new Error("chunk load failed");
    });

    const gateway = await loadGateway();

    // Both values are read by the password authorize callback and the signIn
    // callback as "no mandatory SSO for this domain", so neither may resolve.
    await expect(
      gateway.resolveSsoProviderIdForDomain("acme.com"),
    ).rejects.toThrow(/could not be loaded/);
    await expect(
      gateway.resolveMultiTenantSsoConfig({ providerId: "okta" }),
    ).rejects.toThrow(/could not be loaded/);
  });

  it("does not cache a load failure as an absent configuration", async () => {
    jest.resetModules();
    mockSharedServer();
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
    // A later request retries the import instead of remembering "no SSO".
    await expect(
      gateway.resolveSsoProviderIdForDomain("acme.com"),
    ).resolves.toBe("okta");
    expect(attempts).toBe(2);
  });

  it("reports the feature as disabled, without loading it, when the instance is unlicensed", async () => {
    jest.resetModules();
    mockSharedServer();
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
