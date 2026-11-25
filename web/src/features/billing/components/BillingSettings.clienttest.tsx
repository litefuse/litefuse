import { fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../../utils/api";
import { BillingSettings } from "./BillingSettings";

jest.mock("next/router", () => ({
  useRouter: () => ({ query: {} }),
}));

jest.mock("../../../utils/api", () => {
  const useMutation = () => ({ mutate: jest.fn(), isPending: false });
  return {
    api: {
      useUtils: () => ({
        billing: { getBillingStatus: { invalidate: jest.fn() } },
      }),
      billing: {
        getBillingStatus: { useQuery: jest.fn() },
        createCheckoutSession: { useMutation },
        changePlan: { useMutation },
        createPortalSession: { useMutation: jest.fn(useMutation) },
        cancelSubscription: { useMutation },
        reactivateSubscription: { useMutation },
        clearScheduledChange: { useMutation },
      },
    },
  };
});

const mockedUseQuery = api.billing.getBillingStatus.useQuery as jest.Mock;
const mockedCreatePortalMutation = api.billing.createPortalSession
  .useMutation as jest.Mock;

function billingStatus(
  overrides: Partial<{
    plan: "cloud:developer" | "cloud:pro";
    subscriptionStatus: string | null;
    activeSubscriptionId: string | null;
    scheduledPlan: "cloud:developer" | "cloud:pro" | null;
    cancelAtPeriodEnd: boolean;
    usageState: string | null;
  }> = {},
) {
  const plan = overrides.plan ?? "cloud:developer";
  return {
    isLoading: false,
    data: {
      plan,
      isManualPlanOverride: false,
      isCloudBillingConfigured: true,
      isCheckoutConfigured: true,
      billingConfigurationIssues: [],
      catalogue: [{ plan: "cloud:pro" }],
      stripe: {
        customerId: plan === "cloud:developer" ? null : "cus_test",
        activeSubscriptionId:
          overrides.activeSubscriptionId ??
          (plan === "cloud:developer" ? null : "sub_test"),
        subscriptionStatus: overrides.subscriptionStatus ?? null,
        cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
        currentPeriodEnd: new Date("2026-08-16T00:00:00.000Z"),
        scheduledPlan: overrides.scheduledPlan ?? null,
      },
      usage: {
        currentUnits: plan === "cloud:developer" ? 80_000 : 250_000,
        includedUnits: plan === "cloud:developer" ? 100_000 : 200_000,
        overageUnits: plan === "cloud:developer" ? 0 : 50_000,
        estimatedOverageUsd: plan === "cloud:developer" ? 0 : 2,
        reportedUnits: plan === "cloud:developer" ? null : 240_000,
        pendingUnits: plan === "cloud:developer" ? null : 10_000,
        reportedThrough:
          plan === "cloud:developer"
            ? null
            : new Date("2026-07-16T10:00:00.000Z"),
        state: overrides.usageState ?? null,
      },
      billingCycle: { end: new Date("2026-08-16T00:00:00.000Z") },
    },
  };
}

describe("BillingSettings", () => {
  afterEach(() => mockedUseQuery.mockReset());

  it("refreshes usage while the billing page is open", () => {
    const refetch = jest.fn();
    mockedUseQuery.mockReturnValue({ ...billingStatus(), refetch });

    render(<BillingSettings orgId="org_test" />);

    expect(mockedUseQuery).toHaveBeenCalledWith(
      { orgId: "org_test" },
      expect.objectContaining({ refetchInterval: 60_000 }),
    );

    // Focus refresh is handled by the component's own window listener.
    fireEvent.focus(window);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the Developer allowance and blocked state", () => {
    mockedUseQuery.mockReturnValue(billingStatus({ usageState: "BLOCKED" }));

    render(<BillingSettings orgId="org_test" />);

    expect(screen.getByText("Developer usage limit reached")).toBeTruthy();
    expect(screen.getByText(/80,000 \/ 100,000 units/)).toBeTruthy();
  });

  it("shows Teams, past-due, scheduled downgrade, and overage", () => {
    mockedUseQuery.mockReturnValue(
      billingStatus({
        plan: "cloud:pro",
        subscriptionStatus: "past_due",
        scheduledPlan: "cloud:pro",
      }),
    );

    render(<BillingSettings orgId="org_test" />);

    expect(screen.getByText("Payment needs attention")).toBeTruthy();
    expect(screen.getByText("Scheduled billing change")).toBeTruthy();
    expect(screen.getByText(/Estimated overage before discounts/)).toBeTruthy();
    expect(screen.getByText(/Reported to Stripe: 240,000 units/)).toBeTruthy();
    expect(screen.getByText(/Pending: 10,000 units/)).toBeTruthy();
    expect(screen.getByText("Past due")).toBeTruthy();
    expect(screen.queryByText("Pro + Teams")).toBeNull();
  });

  it("shows cancellation scheduled in the Stripe portal", () => {
    mockedUseQuery.mockReturnValue(
      billingStatus({
        plan: "cloud:pro",
        subscriptionStatus: "active",
        cancelAtPeriodEnd: true,
        scheduledPlan: "cloud:developer",
      }),
    );

    render(<BillingSettings orgId="org_test" />);

    expect(screen.getByText("Cancels at period end")).toBeTruthy();
    expect(screen.getByText("Scheduled billing change")).toBeTruthy();
  });

  it("opens payment methods and invoices in a new tab", () => {
    const portalLocationAssign = jest.fn();
    const portalTab = {
      closed: false,
      location: { assign: portalLocationAssign },
      opener: window,
    } as unknown as Window;
    const openSpy = jest.spyOn(window, "open").mockReturnValue(portalTab);

    mockedUseQuery.mockReturnValue(billingStatus({ plan: "cloud:pro" }));
    mockedCreatePortalMutation.mockImplementationOnce(
      (options: { onSuccess: (result: { url: string }) => void }) => ({
        mutate: jest.fn(() =>
          options.onSuccess({ url: "https://billing.example.com/portal" }),
        ),
        isPending: false,
      }),
    );

    render(<BillingSettings orgId="org_test" />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Payment methods & invoices",
      }),
    );

    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    expect(portalTab.opener).toBeNull();
    expect(portalLocationAssign).toHaveBeenCalledWith(
      "https://billing.example.com/portal",
    );

    openSpy.mockRestore();
  });
});
