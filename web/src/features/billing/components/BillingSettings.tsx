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
import { useState } from "react";
import { toast } from "sonner";

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
  const router = useRouter();
  const utils = api.useUtils();
  const [pendingPlan, setPendingPlan] = useState<PurchasablePlan | null>(null);
  const billingStatus = api.billing.getBillingStatus.useQuery(
    { orgId },
    { refetchOnWindowFocus: false },
  );
  const refresh = () => utils.billing.getBillingStatus.invalidate({ orgId });
  const checkoutMutation = api.billing.createCheckoutSession.useMutation({
    onSuccess: ({ url }) => window.location.assign(url),
    onError: () => setPendingPlan(null),
  });
  const changePlanMutation = api.billing.changePlan.useMutation({
    onSuccess: async () => {
      setPendingPlan(null);
      await refresh();
      toast.success("Billing plan updated.");
    },
    onError: () => setPendingPlan(null),
  });
  const portalMutation = api.billing.createPortalSession.useMutation({
    onSuccess: ({ url }) => window.location.assign(url),
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
        <Header title="Billing" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const data = billingStatus.data;
  const plan = data?.plan ?? "cloud:hobby";
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
      toast.error("No Stripe customer exists for this organization yet.");
      return;
    }
    portalMutation.mutate({ orgId });
  };

  return (
    <div className="flex flex-col gap-6">
      <Header title="Billing" />

      {router.query.checkout === "success" ? (
        <Alert>
          <CreditCard className="h-4 w-4" />
          <AlertTitle>Checkout completed</AlertTitle>
          <AlertDescription>
            Stripe will confirm the subscription by webhook shortly.
          </AlertDescription>
        </Alert>
      ) : null}
      {router.query.checkout === "cancelled" ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Checkout cancelled</AlertTitle>
          <AlertDescription>No billing changes were made.</AlertDescription>
        </Alert>
      ) : null}
      {isPastDue ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Payment needs attention</AlertTitle>
          <AlertDescription>
            Paid access remains enabled during Stripe&apos;s recovery period.
            Update the payment method to avoid a downgrade.
          </AlertDescription>
        </Alert>
      ) : null}
      {usage?.state === "BLOCKED" ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Developer usage limit reached</AlertTitle>
          <AlertDescription>
            New ingestion is paused until the next billing cycle or an upgrade.
          </AlertDescription>
        </Alert>
      ) : null}
      {!data?.isCloudBillingConfigured ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Stripe is not configured</AlertTitle>
          <AlertDescription>
            Configure the Stripe price and webhook variables to enable checkout.
          </AlertDescription>
        </Alert>
      ) : null}
      {configurationIssues.length > 0 ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Stripe price configuration is invalid</AlertTitle>
          <AlertDescription>{configurationIssues.join(" ")}</AlertDescription>
        </Alert>
      ) : null}
      {isManualPlanOverride ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Billing is managed manually</AlertTitle>
          <AlertDescription>
            Contact support to change this organization&apos;s plan or billing
            details.
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="bg-background rounded-lg border">
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-base font-semibold">Current plan</h3>
            <p className="text-muted-foreground text-sm">
              Billing and included units are shared by every project in this
              organization.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={plan === "cloud:hobby" ? "secondary" : "success"}>
              {planLabels[plan as Plan]}
            </Badge>
            {status ? (
              <Badge variant={isPastDue ? "warning" : "outline-solid"}>
                {statusCopy[status] ?? status}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="grid gap-4 border-t p-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <div className="mb-2 flex justify-between text-sm">
              <span>
                {numberFormatter.format(usage?.currentUnits ?? 0)} /{" "}
                {numberFormatter.format(usage?.includedUnits ?? 100_000)} units
              </span>
              <span>Resets {formatDate(data?.billingCycle.end)}</span>
            </div>
            <Progress value={usagePercent} />
            {(usage?.overageUnits ?? 0) > 0 ? (
              <p className="text-muted-foreground mt-2 text-xs">
                Estimated overage before discounts:{" "}
                {currencyFormatter.format(usage?.estimatedOverageUsd ?? 0)}
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
            Payment methods & invoices
          </Button>
        </div>
      </section>

      {data?.stripe.scheduledPlan ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Scheduled billing change</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              {planLabels[data.stripe.scheduledPlan]} begins on{" "}
              {formatDate(data.stripe.currentPeriodEnd)}.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => clearScheduleMutation.mutate({ orgId })}
              loading={clearScheduleMutation.isPending}
            >
              Keep current plan
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-3">
        <PlanCard
          title="Developer"
          price="Free"
          description="For individual projects and proofs of concept."
          features={["100k units each month", "30 days data access", "2 users"]}
          current={plan === "cloud:hobby"}
        />
        <PlanCard
          title="Pro"
          price="$199 / month"
          description="For projects that need scale and longer history."
          features={proFeatures}
          current={plan === "cloud:pro"}
          actionLabel={hasSubscription ? "Switch to Pro" : "Upgrade to Pro"}
          onAction={() => selectPlan("cloud:pro")}
          loading={pendingPlan === "cloud:pro"}
          disabled={!availablePlans.has("cloud:pro") || isManualPlanOverride}
        />
        <PlanCard
          title="Enterprise"
          price="Custom"
          description="For custom scale, deployment, and commercial terms."
          features={[
            "Cloud or self-hosted deployment",
            "Contract pricing and invoicing",
            "Enterprise support and controls",
          ]}
          current={plan === "cloud:enterprise"}
          actionLabel="Contact sales"
          href="mailto:sales@litefuse.ai"
        />
      </section>

      {hasSubscription && !isManualPlanOverride ? (
        <section className="bg-background rounded-lg border p-4">
          <h3 className="text-sm font-semibold">Subscription lifecycle</h3>
          <p className="text-muted-foreground mb-4 text-sm">
            Cancellation takes effect at the end of the current billing period.
          </p>
          {data?.stripe.cancelAtPeriodEnd ? (
            <Button
              variant="outline"
              onClick={() => reactivateMutation.mutate({ orgId })}
              loading={reactivateMutation.isPending}
            >
              Reactivate subscription
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => cancelMutation.mutate({ orgId })}
              loading={cancelMutation.isPending}
            >
              Cancel at period end
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
  return (
    <article className="bg-background flex flex-col rounded-lg border p-4">
      <div className="mb-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{props.title}</h3>
          {props.current ? <Badge variant="success">Current</Badge> : null}
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
