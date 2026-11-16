import { type Plan } from "@langfuse/shared";
import { type CloudConfigSchema } from "@langfuse/shared";
import { resolveSelfHostedPlan } from "@/src/features/entitlements/server/resolveSelfHostedPlan";

/**
 * Get the plan of the organization based on the cloud configuration. Used to add this plan to the organization object in JWT via NextAuth.
 */
export function getOrganizationPlanServerSide(
  cloudConfig?: CloudConfigSchema,
): Plan {
  if (process.env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION) {
    if (cloudConfig) {
      // manual plan override
      if (cloudConfig.plan) {
        switch (cloudConfig.plan) {
          case "Developer":
            return "cloud:developer";
          case "Pro":
            return "cloud:pro";
          default:
            const exhaustiveCheck: never = cloudConfig.plan;
            throw new Error(`Unhandled plan case: ${exhaustiveCheck}`);
        }
      }
      if (
        cloudConfig.stripe?.activeSubscriptionId &&
        cloudConfig.stripe.resolvedPlan
      ) {
        return "cloud:pro";
      }
    }
    return "cloud:developer";
  }

  // Self-hosted: resolve plan from the EE license key (falls back to oss).
  const selfHostedPlan = resolveSelfHostedPlan(
    process.env.LITEFUSE_EE_LICENSE_KEY,
  );
  if (selfHostedPlan) return selfHostedPlan;
  return "oss";
}
