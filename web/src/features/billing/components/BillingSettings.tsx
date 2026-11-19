import Header from "@/src/components/layouts/header";
import { Alert, AlertDescription, AlertTitle } from "@/src/components/ui/alert";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Progress } from "@/src/components/ui/progress";
import { Skeleton } from "@/src/components/ui/skeleton";
import { api } from "@/src/utils/api";
import { planLabels, type Plan } from "@langfuse/shared";
import { AlertCircle, CreditCard, ExternalLink } from "lucide-react";
import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useTranslation } from "react-i18next";
type BillingSettingsProps = { orgId: string };
type PurchasablePlan = "cloud:pro";

const numberFormatter = new Intl.NumberFormat("en-US");
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const statusCopy: Record<string, string> = {
  active: "Active",
  trialing: "Trialing",
  past_due: "Past due",
  canceled: "Canceled",
  unpaid: "Unpaid",
  incomplete: "Incomplete",
  incomplete_expired: "Incomplete expired",
  paused: "Paused",
};

const proFeatures = [
  "200k units included each month",
  "3 years data access",
  "Unlimited users and annotation queues",
  "$4 per additional 100k units",
];

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    new Date(value),
  );
}

export function BillingSettings({ orgId }: BillingSettingsProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const utils = api.useUtils();
  const [pendingPlan, setPendingPlan] = useState<PurchasablePlan | null>(null);
  const portalTabRef = useRef<Window | null>(null);
  const billingStatus = api.billing.getBillingStatus.useQuery(
    { orgId },
    {
      refetchInterval: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const refetchBillingStatus = billingStatus.refetch;
  const returnedFromBillingPortal = router.query.billingPortal === "return";
  useEffect(() => {
    const refreshStripeState = () => {
      void refetchBillingStatus();
    };
    const refreshVisibleStripeState = () => {
      if (document.visibilityState === "visible") refreshStripeState();
    };
    if (returnedFromBillingPortal) refreshStripeState();
    window.addEventListener("focus", refreshStripeState);
    document.addEventListener("visibilitychange", refreshVisibleStripeState);
    return () => {
      window.removeEventListener("focus", refreshStripeState);
      document.removeEventListener(
        "visibilitychange",
        refreshVisibleStripeState,
      );
    };
  }, [refetchBillingStatus, returnedFromBillingPortal]);
  const refresh = () => utils.billing.getBillingStatus.invalidate({ orgId });
  const checkoutMutation = api.billing.createCheckoutSession.useMutation({
    onSuccess: ({ url }) => window.location.assign(url),
    onError: () => setPendingPlan(null),
  });
  const changePlanMutation = api.billing.changePlan.useMutation({
    onSuccess: async () => {
      setPendingPlan(null);
      await refresh();
      toast.success(t("Billing plan updated."));
    },
    onError: () => setPendingPlan(null),
  });
  const portalMutation = api.billing.createPortalSession.useMutation({
    onSuccess: ({ url }) => {
      const portalTab = portalTabRef.current;
      portalTabRef.current = null;

      if (!portalTab || portalTab.closed) {
        toast.error(t("The billing portal tab was closed. Please try again."));
        return;
      }

      portalTab.location.assign(url);
    },
    onError: () => {
      portalTabRef.current?.close();
      portalTabRef.current = null;
    },
  });
  const cancelMutation = api.billing.cancelSubscription.useMutation({
    onSuccess: refresh,
  });
  const reactivateMutation = api.billing.reactivateSubscription.useMutation({
    onSuccess: refresh,
  });
  const clearScheduleMutation = api.billing.clearScheduledChange.useMutation({
    onSuccess: refresh,
  });

  if (billingStatus.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={t("Billing")} />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const data = billingStatus.data;
  const plan = data?.plan ?? "cloud:developer";
  const status = data?.stripe.subscriptionStatus;
  const hasSubscription = Boolean(data?.stripe.activeSubscriptionId);
  const hasCustomer = Boolean(data?.stripe.customerId);
  const isPastDue = status === "past_due";
  const usage = data?.usage;
  const usagePercent = usage
    ? Math.min(100, (usage.currentUnits / usage.includedUnits) * 100)
    : 0;
  const availablePlans = new Set(data?.catalogue.map((entry) => entry.plan));
  const configurationIssues = data?.billingConfigurationIssues ?? [];
  const isManualPlanOverride = data?.isManualPlanOverride ?? false;

  const selectPlan = (targetPlan: PurchasablePlan) => {
    setPendingPlan(targetPlan);
    if (hasSubscription) {
      changePlanMutation.mutate({ orgId, targetPlan });
    } else {
      checkoutMutation.mutate({ orgId, targetPlan });
    }
  };

  const openPortal = () => {
    if (!hasCustomer) {
      toast.error(t("No Stripe customer exists for this organization yet."));
      return;
    }

    const portalTab = window.open("about:blank", "_blank");
    if (!portalTab) {
      toast.error(t("Allow pop-ups to open the billing portal."));
      return;
    }

    portalTab.opener = null;
    portalTabRef.current = portalTab;
    portalMutation.mutate({ orgId });
  };

  return (
    <div className="flex flex-col gap-6">
      <Header title={t("Billing")} />

      {router.query.checkout === "success" ? (
        <Alert>
          <CreditCard className="h-4 w-4" />
          <AlertTitle>{t("Checkout completed")}</AlertTitle>
          <AlertDescription>
            {t("Stripe will confirm the subscription by webhook shortly.")}
          </AlertDescription>
        </Alert>
      ) : null}
      {router.query.checkout === "cancelled" ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("Checkout cancelled")}</AlertTitle>
          <AlertDescription>
            {t("No billing changes were made.")}
          </AlertDescription>
        </Alert>
      ) : null}
      {isPastDue ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("Payment needs attention")}</AlertTitle>
          <AlertDescription>
            {t(
              "Paid access remains enabled during Stripe's recovery period. Update the payment method to avoid a downgrade.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {usage?.state === "BLOCKED" ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("Developer usage limit reached")}</AlertTitle>
          <AlertDescription>
            {t(
              "New ingestion is paused until the next billing cycle or an upgrade.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {!data?.isCloudBillingConfigured ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("Stripe is not configured")}</AlertTitle>
          <AlertDescription>
            {t(
              "Configure the Stripe price and webhook variables to enable checkout.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {configurationIssues.length > 0 ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("Stripe price configuration is invalid")}</AlertTitle>
          <AlertDescription>{configurationIssues.join(" ")}</AlertDescription>
        </Alert>
      ) : null}
      {isManualPlanOverride ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("Billing is managed manually")}</AlertTitle>
          <AlertDescription>
            {t(
              "Contact support to change this organization's plan or billing details.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="bg-background rounded-lg border">
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-base font-semibold">{t("Current plan")}</h3>
            <p className="text-muted-foreground text-sm">
              {t(
                "Billing and included units are shared by every project in this organization.",
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge
              variant={plan === "cloud:developer" ? "secondary" : "success"}
            >
              {planLabels[plan as Plan]}
            </Badge>
            {status ? (
              <Badge variant={isPastDue ? "warning" : "outline-solid"}>
                {data?.stripe.cancelAtPeriodEnd
                  ? t("Cancels at period end")
                  : (statusCopy[status] ?? status)}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="grid gap-4 border-t p-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <div className="mb-2 flex justify-between text-sm">
              <span>
                {numberFormatter.format(usage?.currentUnits ?? 0)} /{" "}
                {t("{{amount}} units", {
                  amount: numberFormatter.format(
                    usage?.includedUnits ?? 100_000,
                  ),
                })}
              </span>
              <span>
                {t("Resets {{date}}", {
                  date: formatDate(data?.billingCycle.end),
                })}
              </span>
            </div>
            <Progress value={usagePercent} />
            {usage?.reportedUnits !== null &&
            usage?.reportedUnits !== undefined ? (
              <p className="text-muted-foreground mt-2 text-xs">
                {t(
                  "Reported to Stripe: {{reported}} units · Pending: {{pending}} units",
                  {
                    reported: numberFormatter.format(usage.reportedUnits),
                    pending: numberFormatter.format(usage.pendingUnits ?? 0),
                  },
                )}
              </p>
            ) : null}
            {(usage?.overageUnits ?? 0) > 0 ? (
              <p className="text-muted-foreground mt-2 text-xs">
                {t("Estimated overage before discounts: {{amount}}", {
                  amount: currencyFormatter.format(
                    usage?.estimatedOverageUsd ?? 0,
                  ),
                })}
              </p>
            ) : null}
          </div>
          <Button
            variant="outline"
            onClick={openPortal}
            loading={portalMutation.isPending}
            disabled={
              !hasCustomer ||
              !data?.isCloudBillingConfigured ||
              isManualPlanOverride
            }
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            {t("Payment methods & invoices")}
          </Button>
        </div>
      </section>

      {data?.stripe.scheduledPlan ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("Scheduled billing change")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              {t("{{plan}} begins on {{date}}.", {
                plan: planLabels[data.stripe.scheduledPlan],
                date: formatDate(data.stripe.currentPeriodEnd),
              })}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => clearScheduleMutation.mutate({ orgId })}
              loading={clearScheduleMutation.isPending}
            >
              {t("Keep current plan")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-3">
        <PlanCard
          title={t("Developer")}
          price={t("Free")}
          description={t("For individual projects and proofs of concept.")}
          features={["100k units each month", "30 days data access", "2 users"]}
          current={plan === "cloud:developer"}
        />
        <PlanCard
          title={t("Pro")}
          price={t("$199 / month")}
          description={t("For projects that need scale and longer history.")}
          features={proFeatures}
          current={plan === "cloud:pro"}
          actionLabel={
            hasSubscription ? t("Switch to Pro") : t("Upgrade to Pro")
          }
          onAction={() => selectPlan("cloud:pro")}
          loading={pendingPlan === "cloud:pro"}
          disabled={!availablePlans.has("cloud:pro") || isManualPlanOverride}
        />
      </section>

      {hasSubscription && !isManualPlanOverride ? (
        <section className="bg-background rounded-lg border p-4">
          <h3 className="text-sm font-semibold">
            {t("Subscription lifecycle")}
          </h3>
          <p className="text-muted-foreground mb-4 text-sm">
            {t(
              "Cancellation takes effect at the end of the current billing period.",
            )}
          </p>
          {data?.stripe.cancelAtPeriodEnd ? (
            <Button
              variant="outline"
              onClick={() => reactivateMutation.mutate({ orgId })}
              loading={reactivateMutation.isPending}
            >
              {t("Reactivate subscription")}
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => cancelMutation.mutate({ orgId })}
              loading={cancelMutation.isPending}
            >
              {t("Cancel at period end")}
            </Button>
          )}
        </section>
      ) : null}
    </div>
  );
}

function PlanCard(props: {
  title: string;
  price: string;
  description: string;
  features: string[];
  current: boolean;
  actionLabel?: string;
  onAction?: () => void;
  href?: string;
  loading?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <article className="bg-background flex flex-col rounded-lg border p-4">
      <div className="mb-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{props.title}</h3>
          {props.current ? (
            <Badge variant="success">{t("Current")}</Badge>
          ) : null}
        </div>
        <p className="mt-1 text-lg font-semibold">{props.price}</p>
        <p className="text-muted-foreground mt-1 text-sm">
          {props.description}
        </p>
      </div>
      <ul className="text-muted-foreground mb-5 flex-1 space-y-2 text-sm">
        {props.features.map((feature) => (
          <li key={feature}>• {feature}</li>
        ))}
      </ul>
      {props.onAction && !props.current ? (
        <Button
          onClick={props.onAction}
          loading={props.loading}
          disabled={props.disabled}
        >
          <CreditCard className="mr-2 h-4 w-4" />
          {props.actionLabel}
        </Button>
      ) : null}
      {props.href && !props.current ? (
        <Button asChild>
          <a href={props.href}>
            <ExternalLink className="mr-2 h-4 w-4" />
            {props.actionLabel}
          </a>
        </Button>
      ) : null}
    </article>
  );
}
