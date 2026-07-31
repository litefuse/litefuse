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
import {
  getFreshBillingUsage,
  getPaidBillingUsage,
} from "./billingUsageService";

type StripeConfigPurpose = "checkout" | "portal" | "webhook";

type BillingStatusStripeClient = {
  subscriptions: {
    retrieve(subscriptionId: string): Promise<Stripe.Subscription>;
  };
  subscriptionSchedules: {
    retrieve(scheduleId: string): Promise<Stripe.SubscriptionSchedule>;
  };
};

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
    cancelAtPeriodEnd?: boolean | null;
    currentPeriodEnd?: string | null;
    meteringStartAt?: string | null;
    meteringEndAt?: string | null;
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
    cancelAtPeriodEnd: patchOrCurrent(
      stripePatch.cancelAtPeriodEnd,
      current?.stripe?.cancelAtPeriodEnd,
    ),
    currentPeriodEnd: patchOrCurrent(
      stripePatch.currentPeriodEnd,
      current?.stripe?.currentPeriodEnd,
    ),
    meteringStartAt: patchOrCurrent(
      stripePatch.meteringStartAt,
      current?.stripe?.meteringStartAt,
    ),
    meteringEndAt: patchOrCurrent(
      stripePatch.meteringEndAt,
      current?.stripe?.meteringEndAt,
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

function subscriptionMeteringStart(
  subscription: Stripe.Subscription,
): Date | null {
  return (
    timestampSecondsToDate(subscription.start_date) ??
    subscriptionPeriodStart(subscription)
  );
}

function subscriptionMeteringEnd(
  subscription: Stripe.Subscription,
  effectiveAt: Date,
): Date {
  return (
    timestampSecondsToDate(subscription.ended_at) ??
    subscriptionPeriodEnd(subscription) ??
    effectiveAt
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
  stripeClient: BillingStatusStripeClient = getStripeClient(),
): Promise<Stripe.SubscriptionSchedule | null> {
  const scheduleId = stripeId(subscription.schedule);
  return scheduleId
    ? await stripeClient.subscriptionSchedules.retrieve(scheduleId)
    : null;
}

function subscriptionSyncState(
  subscription: Stripe.Subscription,
  forceClear: boolean = false,
) {
  const subscriptionPlan = getSubscriptionPlan(subscription);
  const paid =
    !forceClear &&
    PAID_STATUSES.includes(subscription.status) &&
    subscriptionPlan.plan !== null;

  return {
    customerId: stripeId(subscription.customer),
    activeSubscriptionId: paid ? subscription.id : null,
    activeProductId: paid ? subscriptionPlan.proProductId : null,
    activeUsageProductId: paid ? subscriptionPlan.usageProductId : null,
    activeTeamsAddonProductId: paid
      ? subscriptionPlan.teamsAddonProductId
      : null,
    resolvedPlan: paid ? subscriptionPlan.plan : null,
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: paid ? hasScheduledCancellation(subscription) : false,
    currentPeriodEnd:
      subscriptionPeriodEnd(subscription)?.toISOString() ?? null,
    paid,
  };
}

function hasScheduledCancellation(subscription: Stripe.Subscription): boolean {
  return subscription.cancel_at_period_end || subscription.cancel_at != null;
}

function subscriptionNeedsSync(
  subscription: Stripe.Subscription,
  cloudConfig: CloudConfig | null,
): boolean {
  const current = cloudConfig?.stripe;
  const expected = subscriptionSyncState(subscription);
  const expectedMeteringStart =
    subscriptionMeteringStart(subscription)?.toISOString() ?? null;

  return (
    (current?.customerId ?? null) !== expected.customerId ||
    (current?.activeSubscriptionId ?? null) !== expected.activeSubscriptionId ||
    (current?.activeProductId ?? null) !== expected.activeProductId ||
    (current?.activeUsageProductId ?? null) !== expected.activeUsageProductId ||
    (current?.activeTeamsAddonProductId ?? null) !==
      expected.activeTeamsAddonProductId ||
    (current?.resolvedPlan ?? null) !== expected.resolvedPlan ||
    (current?.subscriptionStatus ?? null) !== expected.subscriptionStatus ||
    (current?.cancelAtPeriodEnd ?? false) !== expected.cancelAtPeriodEnd ||
    (current?.currentPeriodEnd ?? null) !== expected.currentPeriodEnd ||
    (current?.meteringStartAt ?? null) !== expectedMeteringStart ||
    (current?.meteringEndAt ?? null) !== null
  );
}

function storedPeriodEnd(cloudConfig: CloudConfig | null): Date | null {
  const value = cloudConfig?.stripe?.currentPeriodEnd;
  return value ? new Date(value) : null;
}

async function getBillingOrganization(orgId: string) {
  return prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
    include: {
      projects: { select: { id: true }, where: { deletedAt: null } },
    },
  });
}

export async function getBillingStatus(
  orgId: string,
  stripeClient?: BillingStatusStripeClient,
) {
  let org = await getBillingOrganization(orgId);
  let cloudConfig = parseCloudConfig(org.cloudConfig);
  let subscriptionId = cloudConfig?.stripe?.activeSubscriptionId;
  let cancelAtPeriodEnd = cloudConfig?.stripe?.cancelAtPeriodEnd ?? false;
  let currentPeriodEnd = storedPeriodEnd(cloudConfig);
  let scheduledPlan: "cloud:hobby" | "cloud:pro" | "cloud:team" | null =
    cancelAtPeriodEnd && subscriptionId ? "cloud:hobby" : null;
  let subscription: Stripe.Subscription | null = null;
  let activeStripeClient = stripeClient;

  if (env.STRIPE_SECRET_KEY && subscriptionId) {
    try {
      activeStripeClient ??= getStripeClient();
      subscription =
        await activeStripeClient.subscriptions.retrieve(subscriptionId);
    } catch (error) {
      logger.warn("Unable to retrieve live Stripe subscription status", {
        orgId,
        subscriptionId,
        error,
      });
    }
  }

  if (subscription) {
    if (subscriptionNeedsSync(subscription, cloudConfig)) {
      await syncSubscriptionToOrganization(subscription);
      org = await getBillingOrganization(orgId);
      cloudConfig = parseCloudConfig(org.cloudConfig);
      subscriptionId = cloudConfig?.stripe?.activeSubscriptionId;
    }

    // The live Stripe response is authoritative for this request. Persistence
    // can remain stale when a webhook is delayed or subscription metadata
    // prevents the generic webhook resolver from applying the update.
    cancelAtPeriodEnd = hasScheduledCancellation(subscription);
    currentPeriodEnd = subscriptionPeriodEnd(subscription);
    scheduledPlan = cancelAtPeriodEnd && subscriptionId ? "cloud:hobby" : null;

    if (subscriptionId && activeStripeClient) {
      try {
        const schedule = await getSubscriptionSchedule(
          subscription,
          activeStripeClient,
        );
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
        }
      } catch (error) {
        logger.warn("Unable to retrieve Stripe subscription schedule", {
          orgId,
          subscriptionId,
          error,
        });
      }
    }
  }

  const plan = getOrganizationPlanServerSide(cloudConfig ?? undefined);
  const includedUnits = plan === "cloud:hobby" ? 100_000 : 200_000;
  const stripeCustomerId = cloudConfig?.stripe?.customerId;
  const hasStripeMetering =
    plan !== "cloud:hobby" && Boolean(subscriptionId && stripeCustomerId);
  const usagePromise =
    hasStripeMetering && stripeCustomerId
      ? getPaidBillingUsage({
          organization: org,
          customerId: stripeCustomerId,
        })
      : getFreshBillingUsage({ organization: org }).then((usage) => ({
          ...usage,
          reportedUnits: null,
          pendingUnits: null,
          reportedThrough: null,
        }));
  const billingConfigurationIssues = getInvalidBillingCatalogueEntries().map(
    (entry) =>
      `${entry.envVar} must be a Stripe Price ID starting with price_. Current value starts with ${entry.value.slice(0, 5)}.`,
  );

  const {
    currentUnits,
    reportedUnits,
    pendingUnits,
    reportedThrough,
    updatedAt: usageUpdatedAt,
  } = await usagePromise;
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
      reportedUnits,
      pendingUnits,
      reportedThrough,
      includedUnits,
      overageUnits: Math.max(0, currentUnits - includedUnits),
      estimatedOverageUsd:
        plan === "cloud:hobby"
          ? 0
          : Math.max(0, currentUnits - includedUnits) * 0.00004,
      state: org.cloudFreeTierUsageThresholdState,
      updatedAt: usageUpdatedAt,
    },
    billingCycle: {
      anchor: org.cloudBillingCycleAnchor,
      end: cycleEnd,
      updatedAt: usageUpdatedAt,
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
  const updatedSubscription = await getStripeClient().subscriptions.update(
    subscription.id,
    {
      cancel_at_period_end: true,
    },
  );
  await syncSubscriptionToOrganization(updatedSubscription);
  return { ok: true } as const;
}

export async function reactivateSubscription(orgId: string) {
  const subscription = await getActiveSubscription(orgId);
  const updatedSubscription = await getStripeClient().subscriptions.update(
    subscription.id,
    {
      cancel_at: "",
      cancel_at_period_end: false,
    },
  );
  await syncSubscriptionToOrganization(updatedSubscription);
  return { ok: true } as const;
}

export async function clearScheduledChange(orgId: string) {
  let subscription = await getActiveSubscription(orgId);
  const schedule = await getSubscriptionSchedule(subscription);
  if (schedule && ["active", "not_started"].includes(schedule.status)) {
    await getStripeClient().subscriptionSchedules.release(schedule.id);
  }
  if (hasScheduledCancellation(subscription)) {
    subscription = await getStripeClient().subscriptions.update(
      subscription.id,
      {
        cancel_at: "",
        cancel_at_period_end: false,
      },
    );
  }
  await syncSubscriptionToOrganization(subscription);
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
  const returnUrl = `${baseUrl}/organization/${encodeURIComponent(params.orgId)}/settings/billing?billingPortal=return`;
  const session = await getStripeClient().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

export async function syncSubscriptionToOrganization(
  subscription: Stripe.Subscription,
  forceClear: boolean = false,
  effectiveAt: Date = new Date(),
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

  const syncState = subscriptionSyncState(subscription, forceClear);
  const anchor = syncState.paid
    ? subscriptionPeriodStart(subscription)
    : subscriptionMeteringEnd(subscription, effectiveAt);
  const meteringStartAt = subscriptionMeteringStart(subscription);
  const meteringEndAt = syncState.paid
    ? null
    : subscriptionMeteringEnd(subscription, effectiveAt);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM organizations
      WHERE id = ${org.id}
      FOR UPDATE
    `;
    const lockedOrg = await tx.organization.findUniqueOrThrow({
      where: { id: org.id },
    });
    const cloudConfig = parseCloudConfig(lockedOrg.cloudConfig);
    const previousPlan = cloudConfig?.stripe?.resolvedPlan ?? null;
    const currentSubscriptionId =
      cloudConfig?.stripe?.activeSubscriptionId ?? null;

    if (
      forceClear &&
      currentSubscriptionId &&
      currentSubscriptionId !== subscription.id
    ) {
      logger.info("Ignoring stale Stripe subscription deletion", {
        orgId: org.id,
        deletedSubscriptionId: subscription.id,
        currentSubscriptionId,
      });
      return { applied: false, previousPlan };
    }

    const anchorChanged =
      Boolean(anchor) &&
      lockedOrg.cloudBillingCycleAnchor?.getTime() !== anchor?.getTime();
    await tx.organization.update({
      where: { id: org.id },
      data: {
        cloudConfig: cloudConfigToJson(cloudConfig, {
          customerId: syncState.customerId,
          activeSubscriptionId: syncState.activeSubscriptionId,
          activeProductId: syncState.activeProductId,
          activeUsageProductId: syncState.activeUsageProductId,
          activeTeamsAddonProductId: syncState.activeTeamsAddonProductId,
          resolvedPlan: syncState.resolvedPlan,
          subscriptionStatus: syncState.subscriptionStatus,
          cancelAtPeriodEnd: syncState.cancelAtPeriodEnd,
          currentPeriodEnd: syncState.currentPeriodEnd,
          meteringStartAt: meteringStartAt?.toISOString() ?? null,
          meteringEndAt: meteringEndAt?.toISOString() ?? null,
        }),
        cloudBillingCycleAnchor: anchor ?? undefined,
        cloudBillingCycleUpdatedAt: anchorChanged ? null : undefined,
        cloudCurrentCycleUsage: anchorChanged ? null : undefined,
        cloudFreeTierUsageThresholdState: null,
      },
    });
    return { applied: true, previousPlan };
  });

  if (result.applied) {
    await new ApiAuthService(prisma, redis).invalidateCachedOrgApiKeys(org.id);
  }
  return {
    orgId: org.id,
    planChanged:
      result.applied && result.previousPlan !== syncState.resolvedPlan,
  };
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
