import { beforeEach, describe, expect, it } from "vitest";
import { clearLocalAppCacheForTest } from "../test-utils/app-cache";
import {
  clearNoEvalConfigsCache,
  hasNoEvalConfigsCache,
  invalidateProjectEvalConfigCaches,
  setNoEvalConfigsCache,
} from "../evalJobConfigCache";

const projectId = "test-project-eval-config-cache";

describe("evalJobConfigCache", () => {
  beforeEach(() => {
    clearLocalAppCacheForTest();
  });

  it("stores and clears the trace-based app cache entry", async () => {
    expect(await hasNoEvalConfigsCache(projectId, "traceBased")).toBe(false);

    await setNoEvalConfigsCache(projectId, "traceBased");
    expect(await hasNoEvalConfigsCache(projectId, "traceBased")).toBe(true);

    await clearNoEvalConfigsCache(projectId, "traceBased");
    expect(await hasNoEvalConfigsCache(projectId, "traceBased")).toBe(false);
  });

  it("invalidates both cache namespaces for a project", async () => {
    await setNoEvalConfigsCache(projectId, "traceBased");
    await setNoEvalConfigsCache(projectId, "eventBased");

    expect(await hasNoEvalConfigsCache(projectId, "traceBased")).toBe(true);
    expect(await hasNoEvalConfigsCache(projectId, "eventBased")).toBe(true);

    await invalidateProjectEvalConfigCaches(projectId);

    expect(await hasNoEvalConfigsCache(projectId, "traceBased")).toBe(false);
    expect(await hasNoEvalConfigsCache(projectId, "eventBased")).toBe(false);
  });
});
