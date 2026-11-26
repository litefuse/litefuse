/** @jest-environment node */

import { createMocks } from "node-mocks-http";
import { type NextApiRequest, type NextApiResponse } from "next";
import { encode } from "next-auth/jwt";
import handler from "@/src/pages/api/auth/sso-logout";
import { getSsoLogoutConfig } from "./ssoProviders";
import { logger } from "@langfuse/shared/src/server";
import { ssoProviderSchema } from "./ssoConfigSchema";

jest.mock("./ssoProviders", () => ({ getSsoLogoutConfig: jest.fn() }));
jest.mock("@langfuse/shared/src/server", () => ({
  logger: { error: jest.fn() },
}));
jest.mock("../../../env.mjs", () => ({
  env: {
    NEXTAUTH_SECRET: "sso-logout-test-secret-that-is-not-a-real-secret",
    NEXTAUTH_URL: "https://litefuse.example.com/observability/api/auth",
    NEXT_PUBLIC_BASE_PATH: "/observability",
    NEXT_PUBLIC_LITEFUSE_CLOUD_REGION: "TEST",
  },
}));

const secret = "sso-logout-test-secret-that-is-not-a-real-secret";
const cookieName = "__Secure-next-auth.session-token.TEST";

describe("GET /api/auth/sso-logout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getSsoLogoutConfig).mockResolvedValue({
      clientId: "tenant-a-app",
      binding: "current-idp-client-binding",
      logout: {
        url: "https://tenant-a.example.com/idp/authCenter/GLO",
        params: {
          clientId: { source: "clientId" },
          redirectToLogin: "true",
          redirectToUrl: { source: "postLogoutRedirectUri" },
        },
      },
    });
  });

  it("uses the signed provider and configured public origin, ignoring caller-supplied destinations", async () => {
    const jwt = await encode({
      secret,
      token: {
        ssoProviderId: "tenant-a.example.com.custom",
        ssoIdToken: "private-id-token",
      },
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: { [cookieName]: jwt },
      headers: {
        host: "evil.example.com",
        "x-forwarded-host": "evil.example.com",
      },
      query: {
        providerId: "tenant-b.example.com.custom",
        callbackUrl: "https://evil.example.com",
      },
    });
    await handler(req, res);

    expect(getSsoLogoutConfig).toHaveBeenCalledWith(
      "tenant-a.example.com.custom",
    );
    const url = new URL(res._getJSONData().url);
    expect(url.hostname).toBe("tenant-a.example.com");
    expect(url.searchParams.get("redirectToUrl")).toBe(
      "https://litefuse.example.com/observability/auth/sign-in",
    );
    expect(res._getData()).not.toContain("private-id-token");
    expect(res.getHeader("Cache-Control")).toContain("no-store");
    expect(res.getHeader("Set-Cookie")).toBeUndefined();
  });

  it("reads chunked secure session cookies", async () => {
    const jwt = await encode({
      secret,
      token: { ssoProviderId: "tenant-a.example.com.custom" },
    });
    const middle = Math.floor(jwt.length / 2);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: {
        [`${cookieName}.0`]: jwt.slice(0, middle),
        [`${cookieName}.1`]: jwt.slice(middle),
      },
    });
    await handler(req, res);
    expect(res._getJSONData().url).toContain("clientId=tenant-a-app");
  });

  it("does not forward an old ID token after the configured IdP or client changes", async () => {
    jest.mocked(getSsoLogoutConfig).mockResolvedValueOnce({
      clientId: "different-client",
      logout: { url: "https://new-idp.example.com/logout" },
      binding: "new-idp-client-binding",
    });
    const jwt = await encode({
      secret,
      token: {
        ssoProviderId: "tenant-a.example.com.custom",
        ssoIdToken: "old-id-token",
      },
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: { [cookieName]: jwt },
    });
    await handler(req, res);
    expect(res._getData()).not.toContain("old-id-token");
  });

  it("forwards the hint only for the same IdP/client that handled this login", async () => {
    jest.mocked(getSsoLogoutConfig).mockResolvedValueOnce({
      clientId: "tenant-a-app",
      logout: { url: "https://idp.example.com/logout" },
      binding: "current-idp-client-binding",
    });
    const jwt = await encode({
      secret,
      token: {
        ssoProviderId: "tenant-a.example.com.custom",
        ssoIdToken: "current-id-token",
        ssoLogoutBinding: "current-idp-client-binding",
      },
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: { [cookieName]: jwt },
    });
    await handler(req, res);
    expect(
      new URL(res._getJSONData().url).searchParams.get("id_token_hint"),
    ).toBe("current-id-token");
  });

  it("continues IdP logout without a hint when the ID token was too large to retain", async () => {
    jest.mocked(getSsoLogoutConfig).mockResolvedValueOnce({
      clientId: "tenant-a-app",
      logout: { url: "https://idp.example.com/logout" },
      binding: "binding",
    });
    const jwt = await encode({
      secret,
      token: {
        ssoProviderId: "tenant-a.example.com.custom",
        ssoLogoutError: "id_token_too_large",
      },
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: { [cookieName]: jwt },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const url = new URL(res._getJSONData().url);
    expect(url.searchParams.get("client_id")).toBe("tenant-a-app");
    expect(url.searchParams.has("id_token_hint")).toBe(false);
  });

  it.each([
    {
      token: {
        ssoLogoutBinding: "binding",
        ssoLogoutError: "id_token_too_large" as const,
      },
      reason: "id_token_too_large",
    },
    {
      token: { ssoLogoutBinding: "binding" },
      reason: "id_token_missing",
    },
    {
      token: {
        ssoLogoutBinding: "previous-binding",
        ssoIdToken: "private-previous-id-token",
      },
      reason: "id_token_binding_mismatch",
    },
    {
      token: {
        ssoLogoutBinding: "previous-binding",
        ssoLogoutError: "id_token_too_large" as const,
      },
      reason: "id_token_binding_mismatch",
    },
  ])(
    "logs $reason when the configured endpoint requires an unavailable hint",
    async ({ token, reason }) => {
      jest.mocked(getSsoLogoutConfig).mockResolvedValueOnce({
        clientId: "tenant-a-app",
        binding: "binding",
        logout: {
          url: "https://idp.example.com/logout",
          ...{ requireIdToken: true },
        },
      });
      const jwt = await encode({
        secret,
        token: {
          ssoProviderId: "tenant-a.example.com.custom",
          ...token,
        },
      });
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        cookies: { [cookieName]: jwt },
      });
      await handler(req, res);
      expect(res.statusCode).toBe(503);
      expect(res._getJSONData()).toEqual({
        error: "SSO logout is unavailable",
      });
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to prepare Enterprise SSO logout",
        { reason },
      );
      const logs = JSON.stringify(jest.mocked(logger.error).mock.calls);
      expect(logs).not.toContain("private-previous-id-token");
      expect(logs).not.toContain("previous-binding");
    },
  );

  it("logs database codes and schema paths without exception details or input values", async () => {
    const invalid = ssoProviderSchema.safeParse({
      domain: "test.com",
      authProvider: "keycloak",
      authConfig: {
        clientId: "app",
        clientSecret: "private-client-secret",
        issuer: "https://idp.example.com",
        logout: { url: "invalid-private-url" },
      },
    });
    const errors = [
      Object.assign(new Error("private-db-details"), { code: "P1001" }),
      invalid.error,
    ];
    const jwt = await encode({
      secret,
      token: { ssoProviderId: "tenant-a.example.com.custom" },
    });
    for (const error of errors) {
      jest.mocked(getSsoLogoutConfig).mockRejectedValueOnce(error);
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        cookies: { [cookieName]: jwt },
      });
      await handler(req, res);
      expect(res.statusCode).toBe(503);
    }
    const logs = JSON.stringify(jest.mocked(logger.error).mock.calls);
    expect(logs).toContain("P1001");
    expect(logs).toContain('"path":["authConfig","logout","url"]');
    expect(logs).not.toContain("private-");
  });

  it.each([undefined, "invalid-jwt"])(
    "does not resolve a provider without a valid browser session",
    async (value) => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        cookies: value ? { [cookieName]: value } : {},
      });
      await handler(req, res);
      expect(res._getJSONData()).toEqual({ url: null });
      expect(getSsoLogoutConfig).not.toHaveBeenCalled();
    },
  );

  it("does not accept a bearer token instead of the browser session", async () => {
    const jwt = await encode({
      secret,
      token: { ssoProviderId: "tenant-a.example.com.custom" },
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { authorization: `Bearer ${jwt}` },
    });
    await handler(req, res);
    expect(res._getJSONData()).toEqual({ url: null });
  });

  it("keeps old or non-enterprise sessions local instead of guessing an IdP by email", async () => {
    const jwt = await encode({
      secret,
      token: { email: "user@tenant-a.example.com" },
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: { [cookieName]: jwt },
    });
    await handler(req, res);
    expect(res._getJSONData()).toEqual({ url: null });
    expect(getSsoLogoutConfig).not.toHaveBeenCalled();
  });

  it("keeps logout local when the enterprise has not configured it", async () => {
    jest.mocked(getSsoLogoutConfig).mockResolvedValue(null);
    const jwt = await encode({
      secret,
      token: { ssoProviderId: "tenant-a.example.com.custom" },
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: { [cookieName]: jwt },
    });
    await handler(req, res);
    expect(res._getJSONData()).toEqual({ url: null });
  });

  it("reports configuration lookup failures without exposing tokens or config secrets", async () => {
    jest
      .mocked(getSsoLogoutConfig)
      .mockRejectedValue(new Error("private configuration details"));
    const jwt = await encode({
      secret,
      token: { ssoProviderId: "tenant-a.example.com.custom" },
    });
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      cookies: { [cookieName]: jwt },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(res._getData()).not.toContain("private configuration details");
  });

  it("rejects unsupported methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(getSsoLogoutConfig).not.toHaveBeenCalled();
  });
});
