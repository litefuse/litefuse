/** @jest-environment node */

import { createMocks } from "node-mocks-http";
import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import { updateSsoLogoutConfig } from "./updateSsoLogoutConfig";

jest.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    ssoConfig: { findUnique: jest.fn(), updateMany: jest.fn() },
  },
}));
jest.mock("@langfuse/shared/src/server", () => ({
  logger: { error: jest.fn() },
}));
jest.mock("../../../env.mjs", () => ({
  env: { ADMIN_API_KEY: "test-admin-key" },
}));
jest.mock("./ssoAvailable", () => ({ isMultiTenantSsoAvailable: true }));

const existingAuthConfig = {
  clientId: "tenant-app",
  clientSecret: "encrypted-secret-must-not-be-reencrypted",
  issuer: "https://idp.example.com",
  name: "Enterprise SSO",
};
const logout = {
  url: "https://idp.example.com/logout",
  params: {
    application: { source: "clientId" },
    returnTo: { source: "postLogoutRedirectUri" },
  },
};

describe("update existing enterprise logout settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(prisma.ssoConfig.findUnique).mockResolvedValue({
      domain: "example.com",
      authProvider: "custom",
      authConfig: existingAuthConfig,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    jest.mocked(prisma.ssoConfig.updateMany).mockResolvedValue({ count: 1 });
  });

  function request(
    body: Record<string, unknown>,
    authorization = "Bearer test-admin-key",
  ) {
    return createMocks<NextApiRequest, NextApiResponse>({
      method: "PATCH",
      headers: { authorization },
      body,
    });
  }

  it("updates only logout settings, preserving the encrypted secret and guarding against concurrent edits", async () => {
    const { req, res } = request({ domain: "example.com", logout });
    await updateSsoLogoutConfig(req, res);
    expect(res.statusCode).toBe(200);
    expect(prisma.ssoConfig.updateMany).toHaveBeenCalledWith({
      where: {
        domain: "example.com",
        authConfig: { equals: existingAuthConfig },
      },
      data: { authConfig: { ...existingAuthConfig, logout } },
    });
    expect(res._getData()).not.toContain("encrypted-secret");
  });

  it("allows administrators to disable global logout", async () => {
    jest.mocked(prisma.ssoConfig.findUnique).mockResolvedValueOnce({
      domain: "example.com",
      authProvider: "custom",
      authConfig: { ...existingAuthConfig, logout },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { req, res } = request({ domain: "example.com", logout: null });
    await updateSsoLogoutConfig(req, res);
    expect(prisma.ssoConfig.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { authConfig: existingAuthConfig } }),
    );
  });

  it("rejects unauthenticated configuration changes before reading the database", async () => {
    const { req, res } = request(
      { domain: "example.com", logout },
      "Bearer invalid",
    );
    await updateSsoLogoutConfig(req, res);
    expect(res.statusCode).toBe(401);
    expect(prisma.ssoConfig.findUnique).not.toHaveBeenCalled();
  });

  it("rejects invalid parameter sources before writing", async () => {
    const { req, res } = request({
      domain: "example.com",
      logout: { ...logout, params: { password: { source: "clientSecret" } } },
    });
    await updateSsoLogoutConfig(req, res);
    expect(res.statusCode).toBe(400);
    expect(prisma.ssoConfig.updateMany).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing enterprise configuration", async () => {
    jest.mocked(prisma.ssoConfig.findUnique).mockResolvedValueOnce(null);
    const { req, res } = request({ domain: "missing.example.com", logout });
    await updateSsoLogoutConfig(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("does not attach enterprise logout to global social-login credentials", async () => {
    jest.mocked(prisma.ssoConfig.findUnique).mockResolvedValueOnce({
      domain: "example.com",
      authProvider: "google",
      authConfig: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { req, res } = request({ domain: "example.com", logout });
    await updateSsoLogoutConfig(req, res);
    expect(res.statusCode).toBe(409);
    expect(prisma.ssoConfig.updateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite a concurrent enterprise configuration change", async () => {
    jest
      .mocked(prisma.ssoConfig.updateMany)
      .mockResolvedValueOnce({ count: 0 });
    const { req, res } = request({ domain: "example.com", logout });
    await updateSsoLogoutConfig(req, res);
    expect(res.statusCode).toBe(409);
  });
});
