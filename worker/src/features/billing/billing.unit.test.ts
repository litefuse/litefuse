import { describe, expect, it } from "vitest";
import {
  billingMeterIdentifier,
  nextUsageState,
  shouldRegisterCloudUsageMeteringQueue,
  shouldRegisterFreeTierUsageThresholdQueue,
} from "./constants";

describe("cloud billing helpers", () => {
  it.each([
    [79_999, null],
    [80_000, "WARNING"],
    [99_999, "WARNING"],
    [100_000, "BLOCKED"],
  ] as const)("maps %s units to %s", (units, expectedState) => {
    expect(nextUsageState(units)).toBe(expectedState);
  });

  it("creates a deterministic per-organization interval identifier", () => {
    const intervalStart = new Date("2026-07-16T09:00:00.000Z");
    expect(billingMeterIdentifier("org_123", intervalStart)).toBe(
      "litefuse:org_123:1784192400",
    );
    expect(billingMeterIdentifier("org_123", intervalStart)).toBe(
      billingMeterIdentifier("org_123", new Date(intervalStart)),
    );
  });

  it("registers cloud usage metering without a cloud region", () => {
    expect(
      shouldRegisterCloudUsageMeteringQueue({
        consumerEnabled: "true",
        stripeSecretKey: "sk_test_123",
      }),
    ).toBe(true);
    expect(
      shouldRegisterCloudUsageMeteringQueue({
        consumerEnabled: "false",
        stripeSecretKey: "sk_test_123",
      }),
    ).toBe(false);
    expect(
      shouldRegisterCloudUsageMeteringQueue({
        consumerEnabled: "true",
        stripeSecretKey: undefined,
      }),
    ).toBe(false);
  });

  it("registers free-tier usage thresholds without a cloud region", () => {
    expect(shouldRegisterFreeTierUsageThresholdQueue("true")).toBe(true);
    expect(shouldRegisterFreeTierUsageThresholdQueue("false")).toBe(false);
  });
});
