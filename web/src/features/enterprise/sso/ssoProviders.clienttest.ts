/** @jest-environment node */

import { prisma } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
import { buildSsoProviders, getSsoLogoutConfig } from "./ssoProviders";

jest.mock("@langfuse/shared/src/db", () => ({
  prisma: { $transaction: jest.fn(), ssoConfig: { findUnique: jest.fn() } },
}));
jest.mock("@langfuse/shared/src/server", () => ({
  logger: { error: jest.fn() },
  traceException: jest.fn(),
}));
jest.mock("@langfuse/shared/encryption", () => ({
  decrypt: (value: string) => value,
}));
jest.mock("./ssoAvailable", () => ({ isMultiTenantSsoAvailable: true }));

const logout = { url: "https://identity.example.com/logout" };
const stored = {
  domain: "team.example.com",
  authProvider: "custom",
  authConfig: {
    name: "Enterprise SSO",
    issuer: "https://identity.example.com",
    clientId: "team-app",
    clientSecret: "encrypted-secret",
    logout,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("resolve logout configuration by login provider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(prisma.ssoConfig.findUnique).mockResolvedValue(stored);
  });

  it("keeps an enterprise login provider available when only its stored logout settings are invalid", async () => {
    jest.mocked(prisma.$transaction).mockResolvedValueOnce([
      {
        ...stored,
        authProvider: "keycloak",
        authConfig: {
          ...stored.authConfig,
          logout: { url: "javascript:invalid" },
        },
      },
    ]);
    const providers = await buildSsoProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].options).toMatchObject({
      id: "team.example.com.keycloak",
      clientId: "team-app",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Invalid Enterprise SSO logout configuration",
      expect.objectContaining({
        domain: stored.domain,
        reason: "invalid_configuration",
      }),
    );
    expect(JSON.stringify(jest.mocked(logger.error).mock.calls)).not.toContain(
      stored.authConfig.clientSecret,
    );
  });

  it("resolves the exact enterprise and returns no login secrets", async () => {
    expect(await getSsoLogoutConfig("team.example.com.custom")).toEqual({
      clientId: "team-app",
      logout,
      binding: expect.any(String),
    });
    expect(prisma.ssoConfig.findUnique).toHaveBeenCalledWith({
      where: { domain: "team.example.com" },
    });
  });

  it("rejects a different provider even when the enterprise domain matches", async () => {
    expect(await getSsoLogoutConfig("team.example.com.keycloak")).toBeNull();
  });

  it("does not apply enterprise logout to a global provider", async () => {
    expect(await getSsoLogoutConfig("custom")).toBeNull();
    expect(prisma.ssoConfig.findUnique).not.toHaveBeenCalled();
  });

  it("does not reuse another enterprise when a configuration has been removed", async () => {
    jest.mocked(prisma.ssoConfig.findUnique).mockResolvedValueOnce(null);
    expect(await getSsoLogoutConfig("removed.example.com.custom")).toBeNull();
  });

  it("uses updated logout settings without waiting for the login provider cache", async () => {
    await getSsoLogoutConfig("team.example.com.custom");
    jest.mocked(prisma.ssoConfig.findUnique).mockResolvedValueOnce({
      ...stored,
      authConfig: {
        ...stored.authConfig,
        logout: { url: "https://identity.example.com/new-logout" },
      },
    });
    expect(await getSsoLogoutConfig("team.example.com.custom")).toMatchObject({
      logout: { url: "https://identity.example.com/new-logout" },
    });
    expect(prisma.ssoConfig.findUnique).toHaveBeenCalledTimes(2);
  });

  it("surfaces lookup errors so the UI can distinguish failure from disabled logout", async () => {
    jest
      .mocked(prisma.ssoConfig.findUnique)
      .mockRejectedValueOnce(new Error("database unavailable"));
    await expect(getSsoLogoutConfig("team.example.com.custom")).rejects.toThrow(
      "database unavailable",
    );
  });
});
