import { env } from "@/src/env.mjs";
import { resolveSelfHostedPlan } from "@/src/features/enterprise/plan/resolvePlan";

/**
 * Whether multi-tenant Enterprise SSO is available:
 * - Cloud deployments (NEXT_PUBLIC_LITEFUSE_CLOUD_REGION set): enabled, unchanged.
 * - Self-hosted deployments: enabled only with an Enterprise license
 *   (LITEFUSE_EE_LICENSE_KEY, i.e. plan `self-hosted:enterprise`). Plain OSS
 *   self-hosted instances (no license) do not get multi-tenant SSO.
 *
 * The Cloud region is checked first so that Cloud availability is never
 * affected by the self-hosted license lookup.
 */
export const isMultiTenantSsoAvailable = Boolean(
  env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION ||
    resolveSelfHostedPlan(env.LITEFUSE_EE_LICENSE_KEY),
);
