export const DEVELOPER_INCLUDED_UNITS = 100_000;
export const DEVELOPER_WARNING_UNITS = 80_000;
export {
  BILLING_METER_EVENT_NAME,
  CLOUD_USAGE_METERING_CRON_NAME,
} from "@langfuse/shared/src/server";

export type UsageState = "WARNING" | "BLOCKED" | null;

export function nextUsageState(total: number): UsageState {
  if (total >= DEVELOPER_INCLUDED_UNITS) return "BLOCKED";
  if (total >= DEVELOPER_WARNING_UNITS) return "WARNING";
  return null;
}

export function billingMeterIdentifier(orgId: string, intervalStart: Date) {
  return `litefuse:${orgId}:${Math.floor(intervalStart.getTime() / 1000)}`;
}

export function shouldRegisterCloudUsageMeteringQueue(params: {
  consumerEnabled: "true" | "false";
  stripeSecretKey?: string;
}) {
  return params.consumerEnabled === "true" && Boolean(params.stripeSecretKey);
}

export function shouldRegisterFreeTierUsageThresholdQueue(
  consumerEnabled: "true" | "false",
) {
  return consumerEnabled === "true";
}
