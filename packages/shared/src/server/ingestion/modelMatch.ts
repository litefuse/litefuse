import { Decimal } from "decimal.js";
import { Prisma } from "../../";
import { env } from "../../env";
import { prisma } from "../../db";
import { Model } from "../../";
import type { PricingTierWithPrices } from "../pricing-tiers";
import {
  deleteAppCacheByPrefix,
  getAppCacheValue,
  instrumentAsync,
  instrumentSync,
  isPgAdvisoryLockHeld,
  logger,
  PgAdvisoryLock,
  recordIncrement,
  setAppCacheValue,
} from "../";

export type ModelMatchProps = {
  projectId: string;
  model: string;
};

export type ModelWithPrices = {
  model: Model | null;
  pricingTiers: PricingTierWithPrices[];
};

const MODEL_MATCH_CACHE_LOCK_KEY = "LOCK:model-match-clear";
const MODEL_MATCH_KEY_PREFIX = "model-price-tiers";
const NOT_FOUND_TOKEN = "LANGFUSE_MODEL_MATCH_NOT_FOUND" as const;

export async function findModel(p: ModelMatchProps): Promise<ModelWithPrices> {
  return instrumentAsync(
    {
      name: "model-match",
      traceScope: "model-match",
    },
    async (span) => {
      if (logger.isLevelEnabled("debug")) {
        logger.debug(`Finding model for ${JSON.stringify(p)}`);
      }

      const cachedResult = await getModelWithPricesFromCache(p);
      if (cachedResult) {
        span.setAttribute("model_match_source", "cache");

        if (cachedResult.model === null) {
          return { model: null, pricingTiers: [] };
        }

        logger.debug(
          `Found model name ${cachedResult.model.modelName} (id: ${cachedResult.model.id}) for project ${p.projectId} and model ${p.model}`,
        );
        span.setAttribute("matched_model_id", cachedResult.model.id);
        return cachedResult;
      }

      const postgresModel = await findModelInPostgres(p);

      if (postgresModel && env.LITEFUSE_CACHE_MODEL_MATCH_ENABLED === "true") {
        const pricingTiers = await findPricingTiersForModel(postgresModel.id);

        if (env.LITEFUSE_CACHE_MODEL_MATCH_ENABLED === "true") {
          await addModelWithPricingTiersToCache(p, postgresModel, pricingTiers);
          span.setAttribute("model_cache_set", "true");
        } else {
          span.setAttribute("model_cache_set", "false");
        }

        span.setAttribute("matched_model_id", postgresModel.id);
        span.setAttribute("model_match_source", "postgres");

        logger.debug(
          `Found model name ${postgresModel.modelName} (id: ${postgresModel.id}) for project ${p.projectId} and model ${p.model}`,
        );

        return { model: postgresModel, pricingTiers };
      }

      span.setAttribute("model_match_source", "none");

        if (env.LITEFUSE_CACHE_MODEL_MATCH_ENABLED === "true") {
          await addModelNotFoundTokenToCache(p);
          span.setAttribute("model_cache_set", "true");
        }

      logger.debug(
        `Model not found for project ${p.projectId} and model ${p.model}`,
      );
      return { model: null, pricingTiers: [] };
    },
  );
}

const getModelWithPricesFromCache = async (
  p: ModelMatchProps,
): Promise<ModelWithPrices | null> => {
  if (env.LITEFUSE_CACHE_MODEL_MATCH_ENABLED === "false") {
    return null;
  }

  try {

    const key = getModelCacheKey(p);
    const cachedValue = await getAppCacheValue<unknown>(key);

    if (!cachedValue) {
      recordIncrement("langfuse.model_match.cache_miss", 1);
      return null;
    }

    recordIncrement("langfuse.model_match.cache_hit", 1);

    if (cachedValue === NOT_FOUND_TOKEN) {
      return { model: null, pricingTiers: [] };
    }

    const parsed = instrumentSync(
      {
        name: "parse-cached-model",
        traceScope: "model-match",
      },
      (span) => {
        span.setAttribute(
          "model-cache-value-length",
          JSON.stringify(cachedValue).length,
        );
        return cachedValue;
      },
    ) as {
      model?: Model;
      pricingTiers?: Array<{
        id: string;
        name: string;
        isDefault: boolean;
        priority: number;
        conditions: PricingTierWithPrices["conditions"];
        prices: Record<string, string>;
      }>;
    };

    if (parsed.model !== undefined && parsed.pricingTiers !== undefined) {
      const model = cachedModelToPrismaModel(parsed.model);
      const pricingTiers: PricingTierWithPrices[] = parsed.pricingTiers.map(
        (tier) => ({
          ...tier,
          prices: Object.entries(tier.prices).map(([usageType, price]) => ({
            usageType,
            price: new Decimal(price),
          })),
        }),
      );

      return { model, pricingTiers };
    }

    logger.warn(
      `Unknown cache format for model match: ${JSON.stringify(parsed)}`,
    );
    return null;
  } catch (error) {
    logger.error(
      `Error getting model for ${JSON.stringify(p)} from cache`,
      error,
    );
    return null;
  }
};

export async function findPricingTiersForModel(
  modelId: string,
): Promise<PricingTierWithPrices[]> {
  if (!modelId) return [];

  const tiers = await prisma.pricingTier.findMany({
    where: { modelId },
    include: {
      prices: {
        select: {
          usageType: true,
          price: true,
        },
      },
    },
    orderBy: { priority: "asc" },
  });

  return tiers.map((tier) => ({
    id: tier.id,
    name: tier.name,
    isDefault: tier.isDefault,
    priority: tier.priority,
    conditions: tier.conditions as PricingTierWithPrices["conditions"],
    prices: tier.prices,
  }));
}

export async function findModelInPostgres(
  p: ModelMatchProps,
): Promise<Model | null> {
  const { projectId, model } = p;
  const modelCondition = model
    ? Prisma.sql`AND ${model} ~ match_pattern`
    : undefined;
  if (!modelCondition) return null;

  const sql = Prisma.sql`
    SELECT
      id,
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      project_id AS "projectId",
      model_name AS "modelName",
      match_pattern AS "matchPattern",
      start_date AS "startDate",
      input_price AS "inputPrice",
      output_price AS "outputPrice",
      total_price AS "totalPrice",
      unit,
      tokenizer_id AS "tokenizerId",
      tokenizer_config AS "tokenizerConfig"
    FROM
      models
    WHERE (project_id = ${projectId}
      OR project_id IS NULL)
    ${modelCondition}
    ORDER BY
      project_id ASC,
      start_date DESC NULLS LAST
    LIMIT 1
  `;

  const foundModels = await prisma.$queryRaw<Array<Model>>(sql);
  return foundModels[0] ?? null;
}

const addModelNotFoundTokenToCache = async (p: ModelMatchProps) => {
  try {
    await setAppCacheValue(getModelCacheKey(p), NOT_FOUND_TOKEN, {
      ttlSeconds: env.LITEFUSE_CACHE_MODEL_MATCH_TTL_SECONDS,
    });
  } catch (error) {
    logger.error(
      `Error adding model not found token for ${JSON.stringify(p)} to cache`,
      error,
    );
  }
};

const addModelWithPricingTiersToCache = async (
  p: ModelMatchProps,
  model: Model,
  pricingTiers: PricingTierWithPrices[],
) => {
  try {
    const cachedPricingTiers = pricingTiers.map((tier) => ({
      ...tier,
      prices: Object.fromEntries(
        tier.prices.map((price) => [price.usageType, price.price.toString()]),
      ),
    }));

    await setAppCacheValue(
      getModelCacheKey(p),
      { model, pricingTiers: cachedPricingTiers },
      { ttlSeconds: env.LITEFUSE_CACHE_MODEL_MATCH_TTL_SECONDS },
    );
  } catch (error) {
    logger.error(
      `Error adding model with pricing tiers for ${JSON.stringify(p)} to cache`,
      error,
    );
  }
};

export const getModelCacheKey = (p: ModelMatchProps) =>
  `${MODEL_MATCH_KEY_PREFIX}:${p.projectId}:${encodeURIComponent(p.model)}`;

export const cachedModelToPrismaModel = (cachedModel: Model): Model => {
  return {
    ...cachedModel,
    createdAt: new Date(cachedModel.createdAt),
    updatedAt: new Date(cachedModel.updatedAt),
    inputPrice:
      cachedModel.inputPrice !== null && cachedModel.inputPrice !== undefined
        ? new Decimal(cachedModel.inputPrice)
        : null,
    outputPrice:
      cachedModel.outputPrice !== null && cachedModel.outputPrice !== undefined
        ? new Decimal(cachedModel.outputPrice)
        : null,
    totalPrice:
      cachedModel.totalPrice !== null && cachedModel.totalPrice !== undefined
        ? new Decimal(cachedModel.totalPrice)
        : null,
    startDate:
      cachedModel.startDate !== null && cachedModel.startDate !== undefined
        ? new Date(cachedModel.startDate)
        : null,
  };
};

export async function clearModelCacheForProject(
  projectId: string,
): Promise<void> {
  if (env.LITEFUSE_CACHE_MODEL_MATCH_ENABLED === "false") {
    return;
  }

  try {
    await deleteAppCacheByPrefix(`${MODEL_MATCH_KEY_PREFIX}:${projectId}:`);
    logger.info(`Cleared model cache entries for project ${projectId}`);
  } catch (error) {
    logger.error(
      `Error clearing model cache for project ${projectId}: ${error}`,
    );
  }
}

export async function isModelMatchCacheLocked() {
  try {
    return await isPgAdvisoryLockHeld(MODEL_MATCH_CACHE_LOCK_KEY);
  } catch (err) {
    logger.error("Failed to check whether model match is locked", err);
    return false;
  }
}

export async function clearFullModelCache() {
  if (env.LITEFUSE_CACHE_MODEL_MATCH_ENABLED === "false") {
    return;
  }

  const lock = new PgAdvisoryLock(MODEL_MATCH_CACHE_LOCK_KEY, {
    ttlSeconds: 60 * 10,
    name: "model-match-clear",
    onUnavailable: "fail",
  });

  const cleared = await lock.withLock(async () => {
    const startTime = Date.now();
    logger.info("Clearing full model cache...");
    await deleteAppCacheByPrefix(MODEL_MATCH_KEY_PREFIX);
    logger.info(`Cleared full model cache in ${Date.now() - startTime}ms.`);
  });

  if (cleared === null) {
    logger.info("Model cache clearing already in progress; skipping.");
  }
}
