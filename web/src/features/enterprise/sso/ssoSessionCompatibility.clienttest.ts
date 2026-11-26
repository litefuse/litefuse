/** @jest-environment node */
import { createHash } from "node:crypto";
import NextAuth, { getServerSession, type NextAuthOptions } from "next-auth";
import { decode, encode } from "next-auth/jwt";
import KeycloakProvider from "next-auth/providers/keycloak";
import { createMocks } from "node-mocks-http";
import { type NextApiRequest, type NextApiResponse } from "next";
import prepareLogout from "@/src/pages/api/auth/sso-logout";
import { getSsoLogoutBinding, rememberSsoSession } from "./ssoLogout";
import { getSsoLogoutConfig } from "./ssoProviders";

jest.mock("./ssoProviders", () => ({ getSsoLogoutConfig: jest.fn() }));
jest.mock("@langfuse/shared/src/server", () => ({
  logger: { error: jest.fn() },
}));
jest.mock("../../../env.mjs", () => ({
  env: {
    NEXTAUTH_SECRET: "legacy-session-compatibility-test-secret",
    NEXTAUTH_URL: "http://localhost:3000",
  },
}));

const secret = "legacy-session-compatibility-test-secret";
const sessionCookie = "next-auth.session-token";
const providerId = "example.com.custom";
const loginConfig = {
  id: providerId,
  clientId: "test-client",
  clientSecret: "test-client-secret",
  issuer: "https://idp.example.com",
};
const options = (): NextAuthOptions => ({
  secret,
  providers: [],
  session: { strategy: "jwt" },
  callbacks: {
    jwt: (params) => rememberSsoSession(params),
    session: async ({ session }) => session,
  },
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
});

async function refreshedToken(res: NextApiResponse) {
  const header = res.getHeader("Set-Cookie");
  const cookies = Array.isArray(header) ? header : [String(header)];
  const cookie = cookies.find((value) => value.startsWith(`${sessionCookie}=`));
  expect(cookie).toBeDefined();
  return decode({
    secret,
    token: decodeURIComponent(
      cookie!.split(";")[0].slice(sessionCookie.length + 1),
    ),
  });
}

describe("legacy sessions through the real NextAuth server", () => {
  beforeEach(() => jest.clearAllMocks());

  it("keeps an existing session valid without guessing its SSO provider", async () => {
    const token = await encode({ secret, token: { email: "old@example.com" } });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: { [sessionCookie]: token },
      headers: {},
    });
    expect((await getServerSession(req, res, options()))?.user?.email).toBe(
      "old@example.com",
    );
    const refreshed = await refreshedToken(res);
    expect(refreshed).not.toHaveProperty("ssoProviderId");
    expect(refreshed).not.toHaveProperty("ssoIdToken");
    expect(getSsoLogoutConfig).not.toHaveBeenCalled();
  });

  it("ignores client attempts to add SSO identity during a session update", async () => {
    const csrf = "csrf-value";
    const token = await encode({ secret, token: { email: "old@example.com" } });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      query: { nextauth: ["session"] },
      headers: {},
      cookies: {
        [sessionCookie]: token,
        "next-auth.csrf-token": `${csrf}|${createHash("sha256")
          .update(csrf + secret)
          .digest("hex")}`,
      },
      body: {
        csrfToken: csrf,
        data: {
          ssoProviderId: providerId,
          ssoIdToken: "untrusted-token",
          ssoLogoutBinding: "untrusted-binding",
        },
      },
    });
    await NextAuth(req, res, options());
    expect(res._getData().user.email).toBe("old@example.com");
    const refreshed = await refreshedToken(res);
    expect(refreshed).not.toHaveProperty("ssoProviderId");
    expect(refreshed).not.toHaveProperty("ssoIdToken");
    expect(refreshed).not.toHaveProperty("ssoLogoutBinding");
  });

  it("prepares local-only logout for the old JWT and IdP logout for the subsequent OAuth session", async () => {
    const oldJwt = await encode({
      secret,
      token: { email: "old@example.com" },
    });
    const old = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: { [sessionCookie]: oldJwt },
    });
    await prepareLogout(old.req, old.res);
    expect(old.res._getJSONData()).toEqual({ url: null });
    expect(getSsoLogoutConfig).not.toHaveBeenCalled();

    const csrf = "logout-csrf";
    const signout = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      query: { nextauth: ["signout"] },
      headers: {},
      cookies: {
        [sessionCookie]: oldJwt,
        "next-auth.csrf-token": `${csrf}|${createHash("sha256")
          .update(csrf + secret)
          .digest("hex")}`,
      },
      body: { csrfToken: csrf, callbackUrl: "/auth/sign-in", json: "true" },
    });
    await NextAuth(signout.req, signout.res, options());
    expect(String(signout.res.getHeader("Set-Cookie"))).toContain(
      `${sessionCookie}=;`,
    );
    expect(signout.res._getJSONData().url).toMatch(/\/auth\/sign-in$/);

    const logout = { url: "https://idp.example.com/logout" };
    const newToken = await rememberSsoSession({
      token: { email: "old@example.com" },
      account: {
        provider: providerId,
        providerAccountId: "idp-user",
        type: "oauth",
        id_token: "this-login-id-token",
      },
      providers: [KeycloakProvider({ ...loginConfig, ...{ logout } })],
    });
    jest.mocked(getSsoLogoutConfig).mockResolvedValue({
      clientId: loginConfig.clientId,
      logout,
      binding: getSsoLogoutBinding(providerId, loginConfig),
    });
    const current = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: { [sessionCookie]: await encode({ secret, token: newToken }) },
    });
    await prepareLogout(current.req, current.res);
    const target = new URL(current.res._getJSONData().url);
    expect(target.origin).toBe("https://idp.example.com");
    expect(target.searchParams.get("client_id")).toBe(loginConfig.clientId);
    expect(target.searchParams.get("id_token_hint")).toBe(
      "this-login-id-token",
    );
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe(
      "http://localhost:3000/auth/sign-in",
    );
  });
});
