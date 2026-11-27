/** @jest-environment node */
import { type NextApiRequest, type NextApiResponse } from "next";
import { encode } from "next-auth/jwt";
import { createMocks } from "node-mocks-http";
import { env } from "@/src/env.mjs";
import prepareLogout from "@/src/pages/api/auth/sso-logout";

jest.mock("./ssoAvailable", () => ({ isMultiTenantSsoAvailable: false }));
jest.mock("@langfuse/shared/src/db", () => ({ prisma: {} }));
jest.mock("@langfuse/shared/src/server", () => ({
  logger: { error: jest.fn() },
}));
jest.mock("../../../env.mjs", () => ({
  env: {
    NEXTAUTH_URL: "http://app.example.test",
    NEXTAUTH_SECRET: "test-session-secret",
    AUTH_CUSTOM_CLIENT_ID: "test-client",
    AUTH_CUSTOM_ISSUER: "https://idp.example.test/idp/api/v3",
  },
}));

const endpoint = "https://idp.example.test/idp/authCenter/GLO";
const settings = {
  url: endpoint,
  params: {
    clientId: { source: "clientId" },
    redirectToLogin: "true",
    redirectToUrl: { source: "postLogoutRedirectUri" },
  },
};

async function prepareFor(provider: string) {
  const jwt = await encode({
    secret: env.NEXTAUTH_SECRET!,
    token: { ssoProviderId: provider },
  });
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: "GET",
    cookies: { "next-auth.session-token": jwt },
  });
  await prepareLogout(req, res);
  return { status: res.statusCode, body: res._getJSONData() };
}

describe("global custom provider sign-out on a self-hosted instance", () => {
  // Only the mocked env object is modified.
  const config = env as { AUTH_CUSTOM_LOGOUT_CONFIG?: string };
  beforeEach(() => {
    config.AUTH_CUSTOM_LOGOUT_CONFIG = JSON.stringify(settings);
  });

  it("prepares GLO for a signed custom session using the configured client and public return URL", async () => {
    const { status, body } = await prepareFor("custom");
    expect(status).toBe(200);
    const url = new URL(body.url);
    expect(url.origin + url.pathname).toBe(endpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      clientId: "test-client",
      redirectToLogin: "true",
      redirectToUrl: "http://app.example.test/auth/sign-in",
    });
  });

  it("keeps password sign-out local even when GLO is configured", async () => {
    expect(await prepareFor("credentials")).toEqual({
      status: 200,
      body: { url: null },
    });
  });

  it("keeps sign-out local when the logout setting is absent", async () => {
    delete config.AUTH_CUSTOM_LOGOUT_CONFIG;
    expect(await prepareFor("custom")).toEqual({
      status: 200,
      body: { url: null },
    });
  });

  it.each(["invalid json", JSON.stringify({ url: "javascript:invalid" })])(
    "reports malformed logout settings through the existing local sign-out fallback",
    async (invalid) => {
      config.AUTH_CUSTOM_LOGOUT_CONFIG = invalid;
      expect(await prepareFor("custom")).toEqual({
        status: 503,
        body: { error: "SSO logout is unavailable" },
      });
    },
  );
});
