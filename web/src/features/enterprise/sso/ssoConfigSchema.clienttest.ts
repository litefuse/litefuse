/** @jest-environment node */

import { ssoProviderSchema, ssoLogoutConfigSchema } from "./ssoConfigSchema";

const enterpriseConfig = {
  domain: "example.com",
  authProvider: "custom",
  authConfig: {
    clientId: "enterprise-app",
    clientSecret: "test-secret",
    name: "Enterprise SSO",
    issuer: "https://idp.example.com",
  },
};

describe("Enterprise SSO logout configuration", () => {
  it("rejects requiring an ID token when the parameter map cannot send it", () => {
    expect(
      ssoLogoutConfigSchema.safeParse({
        url: "https://idp.example.com/logout",
        requireIdToken: true,
        params: { client_id: { source: "clientId" } },
      }).success,
    ).toBe(false);
    expect(
      ssoLogoutConfigSchema.safeParse({
        url: "https://idp.example.com/logout",
        requireIdToken: true,
        params: { hint: { source: "idToken" } },
      }).success,
    ).toBe(true);
  });
  it("validates logout URLs without URL.canParse", () => {
    const original = URL.canParse;
    Object.defineProperty(URL, "canParse", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(
        ssoProviderSchema.safeParse({
          ...enterpriseConfig,
          authConfig: {
            ...enterpriseConfig.authConfig,
            logout: { url: "https://idp.example.com/logout" },
          },
        }).success,
      ).toBe(true);
    } finally {
      Object.defineProperty(URL, "canParse", {
        configurable: true,
        value: original,
      });
    }
  });
  it("preserves custom parameter names, fixed values, and session value sources", () => {
    const logout = {
      url: "https://idp.example.com/idp/authCenter/GLO",
      params: {
        clientId: { source: "clientId" },
        redirectToLogin: "true",
        redirectToUrl: { source: "postLogoutRedirectUri" },
      },
    };
    const parsed = ssoProviderSchema.parse({
      ...enterpriseConfig,
      authConfig: { ...enterpriseConfig.authConfig, logout },
    });

    expect(parsed.authConfig).toHaveProperty("logout", logout);
  });

  it("keeps existing SSO configurations valid without enabling global logout", () => {
    expect(
      ssoProviderSchema.parse(enterpriseConfig).authConfig,
    ).not.toHaveProperty("logout");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,logout",
    "http://idp.example.com/logout",
    "https://user:password@idp.example.com/logout",
    "https://idp.example.com/logout#fragment",
    "/logout",
  ])("rejects an unsafe logout endpoint: %s", (url) => {
    expect(
      ssoProviderSchema.safeParse({
        ...enterpriseConfig,
        authConfig: { ...enterpriseConfig.authConfig, logout: { url } },
      }).success,
    ).toBe(false);
  });

  it("allows a local HTTP IdP for integration testing", () => {
    expect(
      ssoProviderSchema.safeParse({
        ...enterpriseConfig,
        authConfig: {
          ...enterpriseConfig.authConfig,
          logout: { url: "http://localhost:8080/logout" },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects secret or unknown parameter sources", () => {
    expect(
      ssoProviderSchema.safeParse({
        ...enterpriseConfig,
        authConfig: {
          ...enterpriseConfig.authConfig,
          logout: {
            url: "https://idp.example.com/logout",
            params: { secret: { source: "clientSecret" } },
          },
        },
      }).success,
    ).toBe(false);
  });
});
