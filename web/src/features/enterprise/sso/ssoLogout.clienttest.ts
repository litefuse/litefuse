/** @jest-environment node */

import { type Account } from "next-auth";
import { encode, type JWT } from "next-auth/jwt";
import KeycloakProvider from "next-auth/providers/keycloak";
import {
  createSsoLogoutUrl,
  getSsoLogoutBinding,
  rememberSsoSession,
} from "./ssoLogout";
import { type SsoLogoutConfig } from "./ssoConfigSchema";
import { resolveMultiTenantSsoConfig } from "./ssoProviders";

jest.mock("./ssoProviders", () => ({ resolveMultiTenantSsoConfig: jest.fn() }));

const returnTo = "https://litefuse.example.com/observability/auth/sign-in";
const account: Account = {
  provider: "example.com.custom",
  providerAccountId: "user-123",
  type: "oauth",
  id_token: "this-browser-id-token",
};
const loginConfig = {
  id: account.provider,
  clientId: "enterprise-app",
  clientSecret: "test-secret",
  issuer: "https://idp.example.com",
};
const providersFor = (
  logout: SsoLogoutConfig = { url: "https://idp.example.com/logout" },
) => [KeycloakProvider({ ...loginConfig, ...{ logout } })];

describe("Enterprise SSO logout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(resolveMultiTenantSsoConfig).mockResolvedValue({
      isMultiTenantSsoProvider: true,
      domain: "example.com",
    });
  });

  it("maps custom query parameters and URL-encodes the return address once", () => {
    const url = new URL(
      createSsoLogoutUrl({
        clientId: "enterprise/app+1",
        logout: {
          url: "https://idp.example.com:22998/idp/authCenter/GLO",
          params: {
            clientId: { source: "clientId" },
            redirectToLogin: "true",
            redirectToUrl: { source: "postLogoutRedirectUri" },
          },
        },
        returnTo,
        idToken: "must-not-be-sent-to-GLO",
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://idp.example.com:22998/idp/authCenter/GLO",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      clientId: "enterprise/app+1",
      redirectToLogin: "true",
      redirectToUrl: returnTo,
    });
    expect(url.href).not.toContain("must-not-be-sent");
  });

  it("supports standard OIDC logout with the ID token from the current session", () => {
    const url = new URL(
      createSsoLogoutUrl({
        clientId: "enterprise-app",
        logout: { url: "https://idp.example.com/logout?tenant=enterprise" },
        returnTo,
        idToken: account.id_token,
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: "enterprise",
      client_id: "enterprise-app",
      id_token_hint: account.id_token,
      post_logout_redirect_uri: returnTo,
    });
  });

  it("allows OIDC providers to identify the client without an ID token hint", () => {
    const url = new URL(
      createSsoLogoutUrl({
        clientId: "enterprise-app",
        logout: { url: "https://idp.example.com/logout" },
        returnTo,
      }),
    );
    expect(url.searchParams.get("client_id")).toBe("enterprise-app");
    expect(url.searchParams.has("id_token_hint")).toBe(false);
  });

  it("records the actual provider and this login's ID token in the encrypted JWT", async () => {
    const token = await rememberSsoSession({
      token: { email: "user@example.com" },
      account,
      providers: providersFor(),
    });
    expect(token).toMatchObject({
      ssoProviderId: "example.com.custom",
      ssoIdToken: account.id_token,
      ssoLogoutBinding: getSsoLogoutBinding(account.provider, loginConfig),
    });
  });

  it("records the actual login provider even when the provider cache cannot be read", async () => {
    jest
      .mocked(resolveMultiTenantSsoConfig)
      .mockRejectedValueOnce(new Error("cache unavailable"));
    const result = await rememberSsoSession({
      token: {},
      account,
      providers: providersFor(),
    });
    expect(result.ssoProviderId).toBe(account.provider);
    expect(resolveMultiTenantSsoConfig).not.toHaveBeenCalled();
  });

  it("does not save ID tokens when the logout parameter map does not use them", async () => {
    const result = await rememberSsoSession({
      token: {},
      account,
      providers: providersFor({
        url: "https://idp.example.com/GLO",
        params: { clientId: { source: "clientId" } },
      }),
    });
    expect(result.ssoIdToken).toBeUndefined();
  });

  it("does not expand session cookies with large ID tokens", async () => {
    const result = await rememberSsoSession({
      token: {},
      account: { ...account, id_token: "x".repeat(12_000) },
      providers: providersFor(),
    });
    expect(result.ssoIdToken).toBeUndefined();
    expect(result.ssoLogoutError).toBe("id_token_too_large");
    expect(
      (await encode({ token: result, secret: "test-secret" })).length,
    ).toBeLessThan(3800);
  });

  it("keeps the encrypted cookie below 4 KiB near the ID token limit", async () => {
    const token = await rememberSsoSession({
      token: { name: "Test user", email: "user@example.com" },
      account: { ...account, id_token: "x".repeat(2200) },
      providers: providersFor(),
    });
    expect(token.ssoIdToken).toHaveLength(2200);
    expect(
      (await encode({ token, secret: "test-secret" })).length,
    ).toBeLessThan(3800);
  });

  it.each([
    { ...loginConfig, clientId: "other-client" },
    { ...loginConfig, issuer: "https://other-idp.example.com" },
  ])("binds the hint to both the IdP and client", (changed) => {
    expect(getSsoLogoutBinding(account.provider, loginConfig)).not.toBe(
      getSsoLogoutBinding(account.provider, changed),
    );
  });

  it("preserves SSO information during session refreshes", async () => {
    const token: JWT = {
      ssoProviderId: account.provider,
      ssoIdToken: account.id_token,
    };
    expect(await rememberSsoSession({ token })).toEqual(token);
    expect(resolveMultiTenantSsoConfig).not.toHaveBeenCalled();
  });

  it("preserves a legacy session until the user signs in again", async () => {
    const token: JWT = { email: "old@example.com" };
    expect(await rememberSsoSession({ token })).toEqual(token);
    expect(token).not.toHaveProperty("ssoProviderId");
  });

  it("records a fresh password login without SSO tokens", async () => {
    const token = await rememberSsoSession({
      token: {},
      account: {
        provider: "credentials",
        providerAccountId: "user-1",
        type: "credentials",
      },
    });
    expect(token.ssoProviderId).toBe("credentials");
    expect(token).not.toHaveProperty("ssoIdToken");
  });

  it("does not retain an old provider or ID token when a different login method is used", async () => {
    jest
      .mocked(resolveMultiTenantSsoConfig)
      .mockResolvedValue({ isMultiTenantSsoProvider: false, domain: null });
    const token = await rememberSsoSession({
      token: { ssoProviderId: account.provider, ssoIdToken: "old-id-token" },
      account: {
        provider: "credentials",
        providerAccountId: "user-123",
        type: "credentials",
      },
    });
    expect(token.ssoProviderId).toBe("credentials");
    expect(token).not.toHaveProperty("ssoIdToken");
  });

  it("never reuses an ID token from a previous SSO login", async () => {
    const token = await rememberSsoSession({
      token: {
        ssoProviderId: "previous.example.custom",
        ssoIdToken: "old-id-token",
      },
      account: { ...account, id_token: undefined },
    });
    expect(token.ssoProviderId).toBe(account.provider);
    expect(token.ssoIdToken).toBeUndefined();
  });
});
