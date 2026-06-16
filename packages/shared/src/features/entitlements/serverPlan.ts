import type { Prisma } from "../../db";
import { CloudConfigSchema } from "../../interfaces/cloudConfigSchema";
import type { Plan } from "./plans";

export const getOrganizationPlanServerSide = (
  cloudConfig?: CloudConfigSchema | Prisma.JsonValue | null,
): Plan => {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION) {
    const parsedCloudConfig = CloudConfigSchema.safeParse(cloudConfig);
    const normalizedCloudConfig = parsedCloudConfig.success
      ? parsedCloudConfig.data
      : null;

    if (normalizedCloudConfig?.plan) {
      switch (normalizedCloudConfig.plan) {
        case "Hobby":
          return "cloud:hobby";
        case "Core":
          return "cloud:core";
        case "Pro":
          return "cloud:pro";
        case "Team":
          return "cloud:team";
        case "Enterprise":
          return "cloud:enterprise";
      }
    }

    // Stripe-product-id-based plan resolution lived in the EE billing
    // catalogue, which is not part of the OSS build. Fall through to the
    // default cloud:hobby plan when no manual override is set.
    return "cloud:hobby";
  }

  // EE license keys are not supported in the OSS build; self-hosted
  // deployments always resolve to the base self-hosted plan.
  return "oss";
};
