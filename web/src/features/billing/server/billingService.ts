import { env } from "@/src/env.mjs";
import { getOrganizationPlanServerSide } from "@/src/features/entitlements/server/getPlan";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { throwIfNoOrganizationAccess } from "@/src/features/rbac/utils/checkOrganizationAccess";
import {
  CloudConfigSchema,
  type CloudConfigSchema as CloudConfig,
} from "@langfuse/shared";
import {
  prisma,
  type Organization,
  type Prisma,
} from "@langfuse/shared/src/db";
import { getBillingCycleEnd, logger, redis } from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import Stripe from "stripe";
import {
  getBillingCatalogue,
  getBillingEntry,
  getBillingPriceKind,
  getCheckoutLineItems,
  getInvalidBillingCatalogueEntries,
  isBillingCatalogueConfigured,
  type BillingTargetPlan,
} from "./billingCatalogue";

type StripeConfigPurpose = "checkout" | "portal" | "webhook";

const PAID_STATUSES: Stripe.Subscription.Status[] = [
  "active",
  "trialing",
  "past_due",
];

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Stripe is not configured.",
    });
  }

  stripeClient ??= new Stripe(env.STRIPE_SECRET_KEY);
  return stripeClient;
}

export function ensureStripeConfigured(purpose: StripeConfigPurpose): void {
  if (!env.STRIPE_SECRET_KEY) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Stripe secret key is not configured.",
    });
  }

  if (purpose === "checkout" && !isBillingCatalogueConfigured()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Stripe Pro and usage price ids are not configured.",
    });
  }

  if (purpose === "webhook" && !env.STRIPE_WEBHOOK_SECRET) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Stripe webhook secret is not configured.",
    });
  }
}

export function parseCloudConfig(
  cloudConfig: Prisma.JsonValue | null,
): CloudConfig | null {
  if (!cloudConfig) return null;
  const parsed = CloudConfigSchema.safeParse(cloudConfig);
  return parsed.success ? parsed.data : null;
}

function jsonString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stripeId(
  value: string | { id?: string } | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : (value.id ?? null);
}

function timestampSecondsToDate(value: unknown): Date | null {
  return typeof value === "number" ? new Date(value * 1000) : null;
}

function patchOrCurrent<T>(
  patch: T | null | undefined,
  current: T | null | undefined,
): T | null {
  return patch !== undefined ? patch : (current ?? null);
}

function cloudConfigToJson(
  current: CloudConfig | null,
  stripePatch: {
    customerId?: string | null;
    activeSubscriptionId?: string | null;
    activeProductId?: string | null;
    activeUsageProductId?: string | null;
    activeTeamsAddonProductId?: string | null;
    resolvedPlan?: "Pro" | "Team" | null;
    subscriptionStatus?: string | null;
  },
): Prisma.InputJsonObject {
  const next: Record<string, Prisma.InputJsonValue> = {};

  if (current?.plan) next.plan = current.plan;
  if (current?.monthlyObservationLimit !== undefined) {
    next.monthlyObservationLimit = current.monthlyObservationLimit;
  }
  if (current?.defaultLookBackDays !== undefined) {
    next.defaultLookBackDays = current.defaultLookBackDays;
  }
  if (current?.rateLimitOverrides !== undefined) {
    next.rateLimitOverrides =
      current.rateLimitOverrides as Prisma.InputJsonValue;
  }

  next.stripe = {
    customerId: patchOrCurrent(
      stripePatch.customerId,
      current?.stripe?.customerId,
    ),
    activeSubscriptionId: patchOrCurrent(
      stripePatch.activeSubscriptionId,
      current?.stripe?.activeSubscriptionId,
    ),
    activeProductId: patchOrCurrent(
      stripePatch.activeProductId,
      current?.stripe?.activeProductId,
    ),
    activeUsageProductId: patchOrCurrent(
      stripePatch.activeUsageProductId,
      current?.stripe?.activeUsageProductId,
    ),
    activeTeamsAddonProductId: patchOrCurrent(
      stripePatch.activeTeamsAddonProductId,
      current?.stripe?.activeTeamsAddonProductId,
    ),
    resolvedPlan: patchOrCurrent(
      stripePatch.resolvedPlan,
      current?.stripe?.resolvedPlan,
    ),
    subscriptionStatus: patchOrCurrent(
      stripePatch.subscriptionStatus,
      current?.stripe?.subscriptionStatus,
    ),
  };

  return next as Prisma.InputJsonObject;
}

function assertNoManualPlan(cloudConfig: CloudConfig | null): void {
  if (cloudConfig?.plan) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This organization has a manual plan override.",
    });
  }
}

function subscriptionPeriodStart(
  subscription: Stripe.Subscription,
): Date | null {
  const firstItem = subscription.items.data[0] as
    | (Stripe.SubscriptionItem & { current_period_start?: number })
    | undefined;
  return (
    timestampSecondsToDate(
      (subscription as Stripe.Subscription & { current_period_start?: number })
        .current_period_start,
    ) ?? timestampSecondsToDate(firstItem?.current_period_start)
  );
}

function subscriptionPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const firstItem = subscription.items.data[0] as
    | (Stripe.SubscriptionItem & { current_period_end?: number })
    | undefined;
  return (
    timestampSecondsToDate(
      (subscription as Stripe.Subscription & { current_period_end?: number })
        .current_period_end,
    ) ?? timestampSecondsToDate(firstItem?.current_period_end)
  );
}

function getSubscriptionPlan(subscription: Stripe.Subscription): {
  plan: "Pro" | "Team" | null;
  proProductId: string | null;
  usageProductId: string | null;
  teamsAddonProductId: string | null;
} {
  let hasPro = false;
  let hasUsage = false;
  let hasTeamsAddon = false;
  let proProductId: string | null = null;
  let usageProductId: string | null = null;
  let teamsAddonProductId: string | null = null;

  for (const item of subscription.items.data) {
    const kind = getBillingPriceKind(item.price.id);
    if (kind === "pro") {
      hasPro = true;
      proProductId = stripeId(item.price.product);
    } else if (kind === "usage") {
      hasUsage = true;
      usageProductId = stripeId(item.price.product);
    } else if (kind === "teams-addon") {
      hasTeamsAddon = true;
      teamsAddonProductId = stripeId(item.price.product);
    }
  }

  return {
    plan: hasPro && hasUsage ? (hasTeamsAddon ? "Team" : "Pro") : null,
    proProductId,
    usageProductId,
    teamsAddonProductId,
  };
}

async function getSubscriptionSchedule(
  subscription: Stripe.Subscription,
): Promise<Stripe.SubscriptionSchedule | null> {
  const scheduleId = stripeId(subscription.schedule);
  return scheduleId
    ? await getStripeClient().subscriptionSchedules.retrieve(scheduleId)
    : null;
}

export async function getBillingStatus(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
  });
  const cloudConfig = parseCloudConfig(org.cloudConfig);
  const plan = getOrganizationPlanServerSide(cloudConfig ?? undefined);
  const includedUnits = plan === "cloud:hobby" ? 100_000 : 200_000;
  const currentUnits = org.cloudCurrentCycleUsage ?? 0;
  const billingConfigurationIssues = getInvalidBillingCatalogueEntries().map(
    (entry) =>
      `${entry.envVar} must be a Stripe Price ID starting with price_. Current value starts with ${entry.value.slice(0, 5)}.`,
  );

  let cancelAtPeriodEnd = false;
  let currentPeriodEnd: Date | null = null;
  let scheduledPlan: "cloud:hobby" | "cloud:pro" | "cloud:team" | null = null;
  const subscriptionId = cloudConfig?.stripe?.activeSubscriptionId;

  if (env.STRIPE_SECRET_KEY && subscriptionId) {
    try {
      const subscription =
        await getStripeClient().subscriptions.retrieve(subscriptionId);
      cancelAtPeriodEnd = subscription.cancel_at_period_end;
      currentPeriodEnd = subscriptionPeriodEnd(subscription);
      const schedule = await getSubscriptionSchedule(subscription);
      if (schedule?.phases?.length && schedule.phases.length > 1) {
        const finalPhase = schedule.phases[schedule.phases.length - 1];
        const finalKinds = new Set(
          finalPhase.items.map((item) =>
            getBillingPriceKind(
              typeof item.price === "string" ? item.price : item.price.id,
            ),
          ),
        );
        scheduledPlan = finalKinds.has("teams-addon")
          ? "cloud:team"
          : "cloud:pro";
      } else if (cancelAtPeriodEnd) {
        scheduledPlan = "cloud:hobby";
      }
    } catch (error) {
      logger.warn("Unable to retrieve live Stripe subscription status", {
        orgId,
        subscriptionId,
        error,
      });
    }
  }

  const cycleEnd = getBillingCycleEnd(org, new Date());

  return {
    plan,
    isManualPlanOverride: Boolean(cloudConfig?.plan),
    isCloudBillingConfigured: Boolean(env.STRIPE_SECRET_KEY),
    isCheckoutConfigured: isBillingCatalogueConfigured(),
    billingConfigurationIssues,
    catalogue: getBillingCatalogue(),
    stripe: {
      customerId: cloudConfig?.stripe?.customerId ?? null,
      activeSubscriptionId: subscriptionId ?? null,
      activeProductId: cloudConfig?.stripe?.activeProductId ?? null,
      activeUsageProductId: cloudConfig?.stripe?.activeUsageProductId ?? null,
      activeTeamsAddonProductId:
        cloudConfig?.stripe?.activeTeamsAddonProductId ?? null,
      subscriptionStatus: cloudConfig?.stripe?.subscriptionStatus ?? null,
      cancelAtPeriodEnd,
      currentPeriodEnd,
      scheduledPlan,
    },
    usage: {
      currentUnits,
      includedUnits,
      overageUnits: Math.max(0, currentUnits - includedUnits),
      estimatedOverageUsd:
        plan === "cloud:hobby"
          ? 0
          : Math.max(0, currentUnits - includedUnits) * 0.00004,
      state: org.cloudFreeTierUsageThresholdState,
      updatedAt: org.cloudBillingCycleUpdatedAt,
    },
    billingCycle: {
      anchor: org.cloudBillingCycleAnchor,
      end: cycleEnd,
      updatedAt: org.cloudBillingCycleUpdatedAt,
    },
  };
}

async function ensureStripeCustomer(params: {
  org: Organization;
  userEmail?: string | null;
}): Promise<string> {
  const cloudConfig = parseCloudConfig(params.org.cloudConfig);
  const existingCustomerId = cloudConfig?.stripe?.customerId;
  if (existingCustomerId) {
    await getStripeClient().customers.update(existingCustomerId, {
      metadata: {
        orgId: params.org.id,
        cloudRegion: env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION ?? "",
      },
    });
    return existingCustomerId;
  }

  const customer = await getStripeClient().customers.create({
    name: params.org.name,
    email: params.userEmail ?? undefined,
    metadata: {
      orgId: params.org.id,
      cloudRegion: env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION ?? "",
    },
  });

  await prisma.organization.update({
    where: { id: params.org.id },
    data: {
      cloudConfig: cloudConfigToJson(cloudConfig, { customerId: customer.id }),
    },
  });

  return customer.id;
}

export async function createCheckoutSession(params: {
  orgId: string;
  userId: string;
  userEmail?: string | null;
  targetPlan: BillingTargetPlan;
}) {
  ensureStripeConfigured("checkout");
  const entry = getBillingEntry(params.targetPlan);
  if (!entry) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The selected billing plan is not configured.",
    });
  }

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: params.orgId },
  });
  const cloudConfig = parseCloudConfig(org.cloudConfig);
  assertNoManualPlan(cloudConfig);
  if (cloudConfig?.stripe?.activeSubscriptionId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This organization already has an active subscription.",
    });
  }

  const customerId = await ensureStripeCustomer({
    org,
    userEmail: params.userEmail,
  });
  const baseUrl = env.NEXTAUTH_URL.replace(/\/$/, "");
  const billingUrl = `${baseUrl}/organization/${encodeURIComponent(params.orgId)}/settings/billing`;
  const cloudRegion = env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION ?? "";

  const session = await getStripeClient().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: params.orgId,
    line_items: getCheckoutLineItems(params.targetPlan),
    metadata: {
      orgId: params.orgId,
      userId: params.userId,
      targetPlan: params.targetPlan,
      cloudRegion,
    },
    subscription_data: {
      metadata: {
        orgId: params.orgId,
        targetPlan: params.targetPlan,
        cloudRegion,
      },
    },
    success_url: `${billingUrl}?checkout=success`,
    cancel_url: `${billingUrl}?checkout=cancelled`,
  });

  if (!session.url) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Stripe did not return a checkout URL.",
    });
  }
  return { url: session.url };
}

async function getActiveSubscription(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
  });
  const cloudConfig = parseCloudConfig(org.cloudConfig);
  assertNoManualPlan(cloudConfig);
  const subscriptionId = cloudConfig?.stripe?.activeSubscriptionId;
  if (!subscriptionId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This organization does not have an active subscription.",
    });
  }
  return getStripeClient().subscriptions.retrieve(subscriptionId);
}

export async function changePlan(params: {
  orgId: string;
  targetPlan: BillingTargetPlan;
}) {
  ensureStripeConfigured("checkout");
  const target = getBillingEntry(params.targetPlan);
  if (!target) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The selected billing plan is not configured.",
    });
  }
  const subscription = await getActiveSubscription(params.orgId);
  const current = getSubscriptionPlan(subscription).plan;
  const subscriptionMetadata = {
    ...subscription.metadata,
    orgId: params.orgId,
    cloudRegion: env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION ?? "",
    targetPlan: params.targetPlan,
  };
  if (current === "Pro") {
    return { changed: false };
  }

  const periodStart = subscriptionPeriodStart(subscription);
  const periodEnd = subscriptionPeriodEnd(subscription);
  if (!periodStart || !periodEnd) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Stripe subscription period is unavailable.",
    });
  }
  const existingSchedule = await getSubscriptionSchedule(subscription);
  if (
    existingSchedule &&
    ["active", "not_started"].includes(existingSchedule.status)
  ) {
    await getStripeClient().subscriptionSchedules.release(existingSchedule.id);
  }
  await getStripeClient().subscriptions.update(subscription.id, {
    metadata: subscriptionMetadata,
  });
  const schedule = await getStripeClient().subscriptionSchedules.create({
    from_subscription: subscription.id,
  });
  await getStripeClient().subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      {
        start_date: Math.floor(periodStart.getTime() / 1000),
        end_date: Math.floor(periodEnd.getTime() / 1000),
        items: subscription.items.data.map((item) =>
          getBillingPriceKind(item.price.id) === "usage"
            ? { price: item.price.id }
            : { price: item.price.id, quantity: item.quantity ?? 1 },
        ),
      },
      {
        start_date: Math.floor(periodEnd.getTime() / 1000),
        items: target.priceIds.map((price) =>
          getBillingPriceKind(price) === "usage"
            ? { price }
            : { price, quantity: 1 },
        ),
      },
    ],
  });
  return { changed: true, effective: "period_end" as const };
}

export async function cancelSubscription(orgId: string) {
  const subscription = await getActiveSubscription(orgId);
  const schedule = await getSubscriptionSchedule(subscription);
  if (schedule && ["active", "not_started"].includes(schedule.status)) {
    await getStripeClient().subscriptionSchedules.release(schedule.id);
  }
  await getStripeClient().subscriptions.update(subscription.id, {
    cancel_at_period_end: true,
  });
  return { ok: true } as const;
}

export async function reactivateSubscription(orgId: string) {
  const subscription = await getActiveSubscription(orgId);
  await getStripeClient().subscriptions.update(subscription.id, {
    cancel_at_period_end: false,
  });
  return { ok: true } as const;
}

export async function clearScheduledChange(orgId: string) {
  const subscription = await getActiveSubscription(orgId);
  const schedule = await getSubscriptionSchedule(subscription);
  if (schedule && ["active", "not_started"].includes(schedule.status)) {
    await getStripeClient().subscriptionSchedules.release(schedule.id);
  }
  if (subscription.cancel_at_period_end) {
    await getStripeClient().subscriptions.update(subscription.id, {
      cancel_at_period_end: false,
    });
  }
  return { ok: true } as const;
}

export async function createPortalSession(params: { orgId: string }) {
  ensureStripeConfigured("portal");
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: params.orgId },
  });
  const cloudConfig = parseCloudConfig(org.cloudConfig);
  assertNoManualPlan(cloudConfig);
  const customerId = cloudConfig?.stripe?.customerId;
  if (!customerId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This organization does not have a Stripe customer.",
    });
  }
  const baseUrl = env.NEXTAUTH_URL.replace(/\/$/, "");
  const returnUrl = `${baseUrl}/organization/${encodeURIComponent(params.orgId)}/settings/billing`;
  const session = await getStripeClient().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

export async function syncSubscriptionToOrganization(
  subscription: Stripe.Subscription,
  forceClear: boolean = false,
): Promise<{ orgId: string | null; planChanged: boolean }> {
  const customerId = stripeId(subscription.customer);
  const metadataOrgId = jsonString(subscription.metadata?.orgId);
  const cloudRegion = jsonString(subscription.metadata?.cloudRegion);
  const expectedRegion = env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION ?? null;
  if (cloudRegion && expectedRegion && cloudRegion !== expectedRegion) {
    logger.info("Ignoring Stripe subscription for another cloud region", {
      subscriptionId: subscription.id,
      cloudRegion,
      expectedRegion,
    });
    return { orgId: null, planChanged: false };
  }

  const org = metadataOrgId
    ? await prisma.organization.findUnique({ where: { id: metadataOrgId } })
    : customerId
      ? await prisma.organization.findFirst({
          where: {
            cloudConfig: {
              path: ["stripe", "customerId"],
              equals: customerId,
            },
          },
        })
      : null;

  if (!org) {
    logger.warn("Stripe subscription webhook did not match an organization", {
      subscriptionId: subscription.id,
      customerId,
      metadataOrgId,
    });
    return { orgId: null, planChanged: false };
  }

  const cloudConfig = parseCloudConfig(org.cloudConfig);
  const previousPlan = cloudConfig?.stripe?.resolvedPlan ?? null;
  const subscriptionPlan = getSubscriptionPlan(subscription);
  const paid =
    !forceClear &&
    PAID_STATUSES.includes(subscription.status) &&
    subscriptionPlan.plan !== null;
  const nextPlan = paid ? subscriptionPlan.plan : null;
  const anchor = paid
    ? subscriptionPeriodStart(subscription)
    : (subscriptionPeriodEnd(subscription) ?? new Date());
  const anchorChanged =
    Boolean(anchor) &&
    org.cloudBillingCycleAnchor?.getTime() !== anchor?.getTime();

  await prisma.organization.update({
    where: { id: org.id },
    data: {
      cloudConfig: cloudConfigToJson(cloudConfig, {
        customerId,
        activeSubscriptionId: paid ? subscription.id : null,
        activeProductId: paid ? subscriptionPlan.proProductId : null,
        activeUsageProductId: paid ? subscriptionPlan.usageProductId : null,
        activeTeamsAddonProductId: paid
          ? subscriptionPlan.teamsAddonProductId
          : null,
        resolvedPlan: nextPlan,
        subscriptionStatus: subscription.status,
      }),
      cloudBillingCycleAnchor: anchor ?? undefined,
      cloudBillingCycleUpdatedAt: new Date(),
      // Subscription updates and invoice events can occur many times in one
      // cycle. Only reset usage when the actual billing-cycle anchor changes.
      cloudCurrentCycleUsage: anchorChanged ? 0 : undefined,
      cloudFreeTierUsageThresholdState: null,
    },
  });

  await new ApiAuthService(prisma, redis).invalidateCachedOrgApiKeys(org.id);
  return { orgId: org.id, planChanged: previousPlan !== nextPlan };
}

export async function cancelSubscriptionImmediatelyForOrganization(
  orgId: string,
): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return;
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  const subscriptionId = parseCloudConfig(org?.cloudConfig ?? null)?.stripe
    ?.activeSubscriptionId;
  if (subscriptionId) {
    await getStripeClient().subscriptions.cancel(subscriptionId);
  }
}

export async function assertCanManageBilling(params: {
  session: Session | null;
  orgId: string;
}) {
  throwIfNoOrganizationAccess({
    session: params.session,
    organizationId: params.orgId,
    scope: "langfuseCloudBilling:CRUD",
  });
}
