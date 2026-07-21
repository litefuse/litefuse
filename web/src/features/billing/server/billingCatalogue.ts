import { env } from "@/src/env.mjs";
import { z } from "zod/v4";

export const billingTargetPlanSchema = z.enum(["cloud:pro"]);
export type BillingTargetPlan = z.infer<typeof billingTargetPlanSchema>;

export type BillingPriceKind = "pro" | "teams-addon" | "usage";

export type BillingCatalogueEntry = {
  plan: BillingTargetPlan;
  planName: "Pro";
  monthlyPriceUsd: number;
  includedUnits: number;
  priceIds: string[];
};

export type InvalidBillingCatalogueEntry = {
  kind: BillingPriceKind;
  envVar:
    | "STRIPE_PRO_MONTHLY_PRICE_ID"
    | "STRIPE_TEAMS_MONTHLY_ADDON_PRICE_ID"
    | "STRIPE_USAGE_PRICE_ID";
  value: string;
};

const configuredPrices = () => [
  {
    kind: "pro" as const,
    envVar: "STRIPE_PRO_MONTHLY_PRICE_ID" as const,
    priceId: env.STRIPE_PRO_MONTHLY_PRICE_ID,
  },
  {
    kind: "teams-addon" as const,
    envVar: "STRIPE_TEAMS_MONTHLY_ADDON_PRICE_ID" as const,
    priceId: env.STRIPE_TEAMS_MONTHLY_ADDON_PRICE_ID,
  },
  {
    kind: "usage" as const,
    envVar: "STRIPE_USAGE_PRICE_ID" as const,
    priceId: env.STRIPE_USAGE_PRICE_ID,
  },
];

export function isStripePriceId(value: string): boolean {
  return value.startsWith("price_");
}

export function getConfiguredBillingPrices(): Partial<
  Record<BillingPriceKind, string>
> {
  return Object.fromEntries(
    configuredPrices()
      .filter(
        (entry): entry is typeof entry & { priceId: string } =>
          typeof entry.priceId === "string" && isStripePriceId(entry.priceId),
      )
      .map((entry) => [entry.kind, entry.priceId]),
  );
}

export function getInvalidBillingCatalogueEntries(): InvalidBillingCatalogueEntry[] {
  return configuredPrices()
    .filter(
      (entry): entry is typeof entry & { priceId: string } =>
        typeof entry.priceId === "string" && !isStripePriceId(entry.priceId),
    )
    .map(({ kind, envVar, priceId }) => ({ kind, envVar, value: priceId }));
}

export function getBillingCatalogue(): BillingCatalogueEntry[] {
  const prices = getConfiguredBillingPrices();
  const catalogue: BillingCatalogueEntry[] = [];

  if (prices.pro && prices.usage) {
    catalogue.push({
      plan: "cloud:pro",
      planName: "Pro",
      monthlyPriceUsd: 199,
      includedUnits: 200_000,
      priceIds: [prices.pro, prices.usage],
    });
  }

  return catalogue;
}

export function getBillingEntry(
  plan: BillingTargetPlan,
): BillingCatalogueEntry | null {
  return getBillingCatalogue().find((entry) => entry.plan === plan) ?? null;
}

export function getBillingPriceKind(priceId: string): BillingPriceKind | null {
  const prices = getConfiguredBillingPrices();
  return (
    (Object.entries(prices).find(
      ([, configuredId]) => configuredId === priceId,
    )?.[0] as BillingPriceKind | undefined) ?? null
  );
}

export function getCheckoutLineItems(plan: BillingTargetPlan) {
  const entry = getBillingEntry(plan);
  if (!entry) return [];
  return entry.priceIds.map((price) =>
    getBillingPriceKind(price) === "usage" ? { price } : { price, quantity: 1 },
  );
}

export function isBillingCatalogueConfigured(): boolean {
  const prices = getConfiguredBillingPrices();
  return Boolean(prices.pro && prices.usage);
}
