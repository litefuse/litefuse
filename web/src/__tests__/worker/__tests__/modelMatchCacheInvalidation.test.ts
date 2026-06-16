import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@langfuse/shared/src/db";
import {
  clearAppCacheByPrefix,
  clearModelCacheForProject,
  createOrgProjectAndApiKey,
  findModel,
  getAppCacheValueForTest,
  getModelCacheKey,
} from "@langfuse/shared/src/server";

describe("model match cache invalidation", () => {
  beforeEach(async () => {
    await clearAppCacheByPrefix("model-price-tiers:");
  });

  it("reloads updated model prices after explicit cache clearing in single-node mode", async () => {
    const modelName = `model-match-cache-${Date.now()}`;
    const { projectId } = await createOrgProjectAndApiKey();

    const createdModel = await prisma.model.create({
      data: {
        projectId,
        modelName,
        matchPattern: modelName,
        unit: "TOKENS",
      },
    });

    const tier = await prisma.pricingTier.create({
      data: {
        modelId: createdModel.id,
        name: "Standard",
        isDefault: true,
        priority: 0,
        conditions: [],
      },
    });

    await prisma.price.create({
      data: {
        modelId: createdModel.id,
        projectId,
        pricingTierId: tier.id,
        usageType: "input",
        price: "0.03",
      },
    });

    const initialResult = await findModel({ projectId, model: modelName });
    expect(initialResult.model?.modelName).toBe(modelName);
    expect(initialResult.pricingTiers[0]?.prices[0]?.price.toString()).toBe(
      "0.03",
    );

    await prisma.price.updateMany({
      where: {
        modelId: createdModel.id,
        usageType: "input",
      },
      data: {
        price: "0.07",
      },
    });

    const staleCachedResult = await findModel({ projectId, model: modelName });
    expect(staleCachedResult.pricingTiers[0]?.prices[0]?.price.toString()).toBe(
      "0.03",
    );

    await clearModelCacheForProject(projectId);

    const refreshedResult = await findModel({ projectId, model: modelName });
    expect(refreshedResult.model?.modelName).toBe(modelName);
    expect(refreshedResult.pricingTiers[0]?.prices[0]?.price.toString()).toBe(
      "0.07",
    );

    const cacheKey = getModelCacheKey({ projectId, model: modelName });
    const cachedValue = await getAppCacheValueForTest<{
      pricingTiers: Array<{ prices: Record<string, string> }>;
    }>(cacheKey);

    expect(cachedValue?.pricingTiers[0]?.prices.input).toBe("0.07");
  });
});
