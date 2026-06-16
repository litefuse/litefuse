import { expect, describe, it, beforeEach } from "vitest";
import { prisma } from "@langfuse/shared/src/db";
import { createOrgProjectAndApiKey } from "@langfuse/shared/src/server";
import {
  clearAppCacheByPrefix,
  findModel,
  findModelInPostgres,
  getAppCacheValueForTest,
  getModelCacheKey,
  clearModelCacheForProject,
} from "@langfuse/shared/src/server";
import { v4 as uuidv4 } from "uuid";

describe("modelMatch", () => {
  beforeEach(async () => {
    await clearAppCacheByPrefix("model-price-tiers:");
  });

  describe("findModel", () => {
    it("should return model with prices from cache if available", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      const modelId = uuidv4();
      const mockModel = await prisma.model.create({
        data: {
          projectId,
          id: modelId,
          modelName: "gpt-4",
          matchPattern: "gpt-4",
          unit: "TOKENS",
          inputPrice: "1.0123",
          pricingTiers: {
            create: {
              name: "Standard",
              isDefault: true,
              conditions: [],
              priority: 0,
              prices: {
                create: {
                  modelId,
                  usageType: "input",
                  price: "0.03",
                },
              },
            },
          },
        },
      });

      await findModel({ projectId, model: "gpt-4" });
      const result = await findModel({ projectId, model: "gpt-4" });

      expect(result.model).not.toBeNull();
      if (!result.model) {
        throw new Error("Result model is null");
      }
      expect(result.model.id).toEqual(mockModel.id);
      expect(result.pricingTiers).toHaveLength(1);
      expect(result.pricingTiers[0].name).toEqual("Standard");
      expect(result.pricingTiers[0].prices[0].usageType).toEqual("input");
      expect(result.pricingTiers[0].prices[0].price.toString()).toEqual("0.03");

      const cacheKey = getModelCacheKey({ projectId, model: "gpt-4" });
      const cachedValue = await getAppCacheValueForTest<{
        model: { id: string; projectId: string };
        pricingTiers: Array<{ name: string }>;
      }>(cacheKey);

      expect(cachedValue).not.toBeNull();
      expect(cachedValue?.model.id).toEqual(mockModel.id);
      expect(cachedValue?.model.projectId).toEqual(mockModel.projectId);
      expect(cachedValue?.pricingTiers).toHaveLength(1);
      expect(cachedValue?.pricingTiers[0].name).toEqual("Standard");
    });

    it("should query Postgres if cache misses", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      const mockModel = await prisma.model.create({
        data: {
          projectId,
          modelName: "gpt-4",
          matchPattern: "gpt-4",
          unit: "TOKENS",
        },
      });

      const result = await findModel({
        projectId,
        model: "gpt-4",
      });

      expect(result.model).toEqual(mockModel);
      expect(result.pricingTiers).toEqual([]);
    });

    it("should cache not found models", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      const nonExistentModel = "nonexistent-model";

      const result1 = await findModel({
        projectId,
        model: nonExistentModel,
      });
      expect(result1.model).toBeNull();
      expect(result1.pricingTiers).toEqual([]);

      const result2 = await findModel({
        projectId,
        model: nonExistentModel,
      });
      expect(result2.model).toBeNull();
      expect(result2.pricingTiers).toEqual([]);

      const cacheKey = getModelCacheKey({
        projectId,
        model: nonExistentModel,
      });
      const cachedValue = await getAppCacheValueForTest<string>(cacheKey);
      expect(cachedValue).toBe("LANGFUSE_MODEL_MATCH_NOT_FOUND");
    });
  });

  describe("findModelInPostgres", () => {
    it("should find model by exact match pattern", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      const mockModel = await prisma.model.create({
        data: {
          projectId,
          modelName: "gpt-4",
          matchPattern: "gpt-4",
          unit: "TOKENS",
        },
      });

      const result = await findModelInPostgres({
        projectId,
        model: "gpt-4",
      });

      expect(result).toEqual(mockModel);
    });

    it("should find model by regex match pattern", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      const mockModel = await prisma.model.create({
        data: {
          projectId,
          modelName: "gpt-4-turbo",
          matchPattern: "gpt-4.*",
          unit: "TOKENS",
        },
      });

      const result = await findModelInPostgres({
        projectId,
        model: "gpt-4-turbo",
      });

      expect(result).toEqual(mockModel);
    });

    it("should return null when no model matches", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      const result = await findModelInPostgres({
        projectId,
        model: "nonexistent-model",
      });

      expect(result).toBeNull();
    });
  });

  describe("clearModelCacheForProject", () => {
    it("should clear all cached models for a project", async () => {
      const { projectId } = await createOrgProjectAndApiKey();

      await prisma.model.create({
        data: {
          projectId,
          modelName: "gpt-4",
          matchPattern: "gpt-4",
          unit: "TOKENS",
          inputPrice: "1.0",
        },
      });

      await prisma.model.create({
        data: {
          projectId,
          modelName: "gpt-3.5-turbo",
          matchPattern: "gpt-3.5-turbo",
          unit: "TOKENS",
          inputPrice: "0.5",
        },
      });

      await findModel({ projectId, model: "gpt-4" });
      await findModel({ projectId, model: "gpt-3.5-turbo" });

      const key1 = getModelCacheKey({ projectId, model: "gpt-4" });
      const key2 = getModelCacheKey({ projectId, model: "gpt-3.5-turbo" });

      expect(await getAppCacheValueForTest(key1)).not.toBeNull();
      expect(await getAppCacheValueForTest(key2)).not.toBeNull();

      await clearModelCacheForProject(projectId);

      expect(await getAppCacheValueForTest(key1)).toBeNull();
      expect(await getAppCacheValueForTest(key2)).toBeNull();
    });

    it("should clear cached not-found tokens for a project", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      const nonExistentModel = "nonexistent-model";

      await findModel({ projectId, model: nonExistentModel });

      const key = getModelCacheKey({ projectId, model: nonExistentModel });
      expect(await getAppCacheValueForTest(key)).toBe(
        "LANGFUSE_MODEL_MATCH_NOT_FOUND",
      );

      await clearModelCacheForProject(projectId);

      expect(await getAppCacheValueForTest(key)).toBeNull();
    });
  });
});
