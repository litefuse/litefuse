import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalAppCacheForTest,
  getAppCacheEntry,
} from "../test-utils/app-cache";

describe("otelProjectTracking", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("LITEFUSE_SKIP_FINAL_FOR_OTEL_PROJECTS", "true");
    clearLocalAppCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("marks OTEL projects in app cache when feature is enabled", async () => {
    const { isProjectOtelUser, markProjectAsOtelUser } = await import(
      "../otelProjectTracking.js"
    );
    const projectId = "otel-project-enabled";

    expect(await isProjectOtelUser(projectId)).toBe(false);

    await markProjectAsOtelUser(projectId);

    expect(await isProjectOtelUser(projectId)).toBe(true);

    const entry = await getAppCacheEntry(
      `langfuse:project:${projectId}:otel:active`,
    );
    expect(entry).not.toBeNull();

    if (!entry) {
      return;
    }

    expect(entry.value).toBe("1");
    expect(entry.expiresAt).not.toBeNull();
  }, 10000);

  it("skips cache writes when feature is disabled", async () => {
    vi.stubEnv("LITEFUSE_SKIP_FINAL_FOR_OTEL_PROJECTS", "false");
    vi.resetModules();

    const { isProjectOtelUser, markProjectAsOtelUser } = await import(
      "../otelProjectTracking.js"
    );
    const projectId = "otel-project-disabled";

    await markProjectAsOtelUser(projectId);

    expect(await isProjectOtelUser(projectId)).toBe(false);
    expect(
      await getAppCacheEntry(`langfuse:project:${projectId}:otel:active`),
    ).toBeNull();
  }, 10000);
});
