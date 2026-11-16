/** @jest-environment node */

import { signOut } from "next-auth/react";
import { signOutWithSso } from "./signOutWithSso";

jest.mock("next-auth/react", () => ({ signOut: jest.fn() }));
jest.mock("../../../env.mjs", () => ({
  env: { NEXT_PUBLIC_BASE_PATH: "/observability" },
}));

const originalFetch = global.fetch;
const localUrl = "https://litefuse.example.com/observability/auth/sign-in";

describe("sign out with Enterprise SSO", () => {
  beforeEach(() => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ url: null }) });
    jest
      .mocked(signOut)
      .mockReset()
      .mockImplementation(async (options) => ({
        url: new URL(
          options?.callbackUrl ?? "/observability/auth/sign-in",
          "https://litefuse.example.com",
        ).toString(),
      }));
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("prepares the IdP URL while authenticated, then waits for local logout before returning it", async () => {
    const idpUrl = "https://idp.example.com/idp/authCenter/GLO?clientId=app";
    jest.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ url: idpUrl }),
    } as Response);
    let finishLocalLogout!: (value: { url: string }) => void;
    jest.mocked(signOut).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLocalLogout = resolve;
        }),
    );
    const onRedirect = jest.fn();
    const pending = signOutWithSso().then(onRedirect);
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetch).toHaveBeenCalledWith(
      "/observability/api/auth/sso-logout",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(signOut).toHaveBeenCalledWith({
      redirect: false,
      callbackUrl: "/observability/auth/sign-in",
    });
    expect(onRedirect).not.toHaveBeenCalled();
    finishLocalLogout({ url: localUrl });
    await pending;
    expect(onRedirect).toHaveBeenCalledWith(idpUrl);
  });

  it("preserves local-only logout when no enterprise logout is configured", async () => {
    expect(await signOutWithSso()).toBe(localUrl);
  });

  it("works without AbortSignal.timeout", async () => {
    const original = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: undefined,
    });
    try {
      jest.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ url: "https://idp.example.com/logout" }),
      } as Response);
      expect(await signOutWithSso()).toBe("https://idp.example.com/logout");
    } finally {
      Object.defineProperty(AbortSignal, "timeout", {
        configurable: true,
        value: original,
      });
    }
  });

  it.each(["network", "http", "malformed"])(
    "still signs out locally and reports an IdP preparation failure: %s",
    async (failure) => {
      if (failure === "network")
        jest.mocked(fetch).mockRejectedValue(new Error("unavailable"));
      if (failure === "http")
        jest.mocked(fetch).mockResolvedValue({ ok: false } as Response);
      if (failure === "malformed")
        jest.mocked(fetch).mockResolvedValue({
          ok: true,
          json: async () => ({ url: "javascript:alert(1)" }),
        } as Response);
      await signOutWithSso();
      expect(signOut).toHaveBeenCalledWith({
        redirect: false,
        callbackUrl: "/observability/auth/sign-in?error=SSOLogoutError",
      });
    },
  );

  it("does not proceed to the IdP when local logout fails", async () => {
    jest.mocked(signOut).mockRejectedValue(new Error("local logout failed"));
    await expect(signOutWithSso()).rejects.toThrow("local logout failed");
  });

  it("reports a rejected local sign-out so the user can retry the complete SSO flow", async () => {
    jest.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://idp.example.com/logout" }),
    } as Response);
    jest.mocked(signOut).mockResolvedValue({
      url: "https://litefuse.example.com/api/auth/signout?csrf=true",
    });
    await expect(signOutWithSso()).rejects.toThrow(
      "Local sign-out was not completed",
    );
  });
});
