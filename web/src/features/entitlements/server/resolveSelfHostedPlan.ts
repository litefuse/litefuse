import { type Plan } from "@langfuse/shared";

/**
 * Plan resolution for self-hosted instances: maps the EE license key prefix to a plan.
 * - litefuse_ee_ → self-hosted:enterprise
 * Returns null when there is no license or the prefix is unrecognized (falls back to the base oss plan).
 *
 * Together with the Cloud branch (which reads cloudConfig.plan) this forms the complete plan resolution logic;
 * see @/src/features/entitlements/server/getPlan for the integration point.
 *
 * Lives in the entitlements feature (MIT) rather than in the enterprise modules:
 * the community edition resolves its own plan on every request, so the check has
 * to be usable without loading any licensed code. The enterprise code imports it
 * from here.
 */
export function resolveSelfHostedPlan(licenseKey?: string): Plan | null {
  if (!licenseKey) return null;
  if (licenseKey.startsWith("litefuse_ee_")) return "self-hosted:enterprise";
  return null;
}
