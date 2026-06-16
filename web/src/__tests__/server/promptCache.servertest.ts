import { type Prompt, type PrismaClient } from "@prisma/client";
import {
  clearLocalAppCacheForTest,
  getAppCacheEntry,
  getAppCacheValueForTest,
  PromptService,
  setAppCacheValue,
} from "@langfuse/shared/src/server";

describe("PromptService", () => {
  let promptService: PromptService;
  let mockPrisma: jest.Mocked<PrismaClient>;
  let mockMetricIncrementer: jest.Mock;

  const promptTimestamps = {
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-02T00:00:00.000Z"),
  };

  const mockPrompt: Prompt = {
    id: "1",
    projectId: "project1",
    name: "testPrompt",
    version: 1,
    prompt: "Test prompt content",
    labels: ["test"],
    createdBy: "API",
    type: "text",
    isActive: false,
    config: {},
    tags: [],
    commitMessage: null,
    ...promptTimestamps,
  };

  const resolvedPrompt = {
    ...mockPrompt,
    resolutionGraph: null,
  };

  const cachedPrompt = {
    ...resolvedPrompt,
    createdAt: promptTimestamps.createdAt.toISOString(),
    updatedAt: promptTimestamps.updatedAt.toISOString(),
  };

  const epochKey = "prompt_cache_epoch:project1";
  const promptCacheKey = "prompt:project1:epoch-1:testPrompt:1";

  beforeEach(() => {
    clearLocalAppCacheForTest();

    mockPrisma = {
      prompt: {
        findFirst: jest.fn(),
      },
      promptDependency: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as unknown as jest.Mocked<PrismaClient>;

    mockMetricIncrementer = jest.fn();
    promptService = new PromptService(mockPrisma, mockMetricIncrementer, true);
  });

  describe("getPrompt", () => {
    it("returns the cached prompt when the app cache is warm", async () => {
      await setAppCacheValue(epochKey, "epoch-1");
      await setAppCacheValue(promptCacheKey, cachedPrompt);

      const result = await promptService.getPrompt({
        projectId: "project1",
        promptName: "testPrompt",
        version: 1,
        label: undefined,
      });

      expect(result).toEqual(cachedPrompt);
      expect(mockPrisma.prompt.findFirst).not.toHaveBeenCalled();
      expect(mockMetricIncrementer).toHaveBeenCalledWith("prompt_cache_hit", 1);
    });

    it("reads from the database and populates app cache on a miss", async () => {
      await setAppCacheValue(epochKey, "epoch-1");
      mockPrisma.prompt.findFirst.mockResolvedValue(mockPrompt as never);

      const result = await promptService.getPrompt({
        projectId: "project1",
        promptName: "testPrompt",
        version: 1,
        label: undefined,
      });

      expect(result).toEqual(resolvedPrompt);
      expect(mockPrisma.prompt.findFirst).toHaveBeenCalled();
      expect(mockMetricIncrementer).toHaveBeenCalledWith(
        "prompt_cache_miss",
        1,
      );
      expect(
        await getAppCacheValueForTest<typeof cachedPrompt>(promptCacheKey),
      ).toEqual(cachedPrompt);
    });

    it("bypasses cache entirely when resolve is false", async () => {
      mockPrisma.prompt.findFirst.mockResolvedValue(mockPrompt as never);

      const result = await promptService.getPrompt({
        projectId: "project1",
        promptName: "testPrompt",
        version: 1,
        label: undefined,
        resolve: false,
      });

      expect(result).toEqual(resolvedPrompt);
      expect(mockPrisma.prompt.findFirst).toHaveBeenCalled();
      expect(await getAppCacheValueForTest(epochKey)).toBeNull();
      expect(mockMetricIncrementer).not.toHaveBeenCalled();
    });
  });

  describe("invalidateCache", () => {
    it("rotates the epoch token for the project", async () => {
      await promptService.invalidateCache({
        projectId: "project1",
      });

      const entry = await getAppCacheEntry(epochKey);
      expect(entry).not.toBeNull();

      if (!entry) {
        return;
      }

      expect(typeof entry.value).toBe("string");
      expect((entry.value as string).length).toBeGreaterThan(0);
      expect(entry.expiresAt).not.toBeNull();
    });
  });

  describe("caching disabled", () => {
    beforeEach(() => {
      promptService = new PromptService(
        mockPrisma,
        mockMetricIncrementer,
        false,
      );
    });

    it("does not read or write app cache when disabled", async () => {
      mockPrisma.prompt.findFirst.mockResolvedValue(mockPrompt as never);

      const result = await promptService.getPrompt({
        projectId: "project1",
        promptName: "testPrompt",
        version: 1,
        label: undefined,
      });

      expect(result).toEqual(resolvedPrompt);
      expect(mockPrisma.prompt.findFirst).toHaveBeenCalled();
      expect(await getAppCacheValueForTest(epochKey)).toBeNull();
      expect(mockMetricIncrementer).not.toHaveBeenCalled();
    });
  });
});
