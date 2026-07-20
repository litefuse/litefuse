/** @jest-environment node */

import {
  billingTargetPlanSchema,
  getBillingCatalogue,
  getCheckoutLineItems,
  getInvalidBillingCatalogueEntries,
} from "@/src/features/billing/server/billingCatalogue";
import {
  parseCloudConfig,
  syncSubscriptionToOrganization,
} from "@/src/features/billing/server/billingService";
import { handleStripeWebhook } from "@/src/features/billing/server/stripeWebhookHandler";
import { getOrganizationPlanServerSide } from "@/src/features/entitlements/server/getPlan";
import { env } from "@/src/env.mjs";
import { appRouter } from "@/src/server/api/root";
import { createInnerTRPCContext } from "@/src/server/api/trpc";
import { prisma, Role } from "@langfuse/shared/src/db";
import type { Plan } from "@langfuse/shared";
import type { Session } from "next-auth";
import Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";

const STRIPE_SECRET_KEY = "sk_test_litefuse";
const STRIPE_WEBHOOK_SECRET = "whsec_litefuse";
const STRIPE_PRO_MONTHLY_PRICE_ID = "price_litefuse_pro_monthly";
const STRIPE_TEAMS_MONTHLY_ADDON_PRICE_ID = "price_litefuse_teams_monthly";
const STRIPE_USAGE_PRICE_ID = "price_litefuse_usage";

beforeAll(() => {
  Object.assign(env, {
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    STRIPE_PRO_MONTHLY_PRICE_ID,
    STRIPE_TEAMS_MONTHLY_ADDON_PRICE_ID,
    STRIPE_USAGE_PRICE_ID,
  });
});

async function createBillingOrg(role: Role = Role.OWNER) {
  const org = await prisma.organization.create({
    data: {
      id: uuidv4(),
      name: `Billing Org ${uuidv4().slice(0, 8)}`,
      cloudConfig: {
        stripe: {
          customerId: `cus_${uuidv4()}`,
        },
      },
    },
  });
  const user = await prisma.user.create({
    data: {
      id: uuidv4(),
      email: `billing-${uuidv4().slice(0, 8)}@example.com`,
      name: "Billing Test User",
    },
  });
  await prisma.organizationMembership.create({
    data: {
      orgId: org.id,
      userId: user.id,
      role,
    },
  });

  return { org, user };
}

function createSession(params: {
  user: { id: string; email: string | null; name: string | null };
  org: { id: string; name: string };
  role: Role;
  plan?: Plan;
}): Session {
  return {
    expires: "1",
    user: {
      id: params.user.id,
      email: params.user.email,
      name: params.user.name,
      canCreateOrganizations: true,
      organizations: [
        {
          id: params.org.id,
          name: params.org.name,
          role: params.role,
          plan: params.plan ?? "cloud:hobby",
          cloudConfig: undefined,
          metadata: {},
          aiFeaturesEnabled: false,
          projects: [],
        },
      ],
      featureFlags: {
        excludeClickhouseRead: false,
        templateFlag: true,
      },
      admin: false,
    },
    environment: {
      enableExperimentalFeatures: false,
      selfHostedInstancePlan: null,
    },
  };
}

function createCaller(session: Session) {
  const ctx = createInnerTRPCContext({ session, headers: {} });
  return appRouter.createCaller({ ...ctx, prisma });
}

function createSubscription(params: {
  orgId: string;
  customerId: string;
  status: Stripe.Subscription.Status;
  subscriptionId?: string;
  team?: boolean;
}): Stripe.Subscription {
  return {
    id: params.subscriptionId ?? `sub_${uuidv4()}`,
    customer: params.customerId,
    status: params.status,
    metadata: {
      orgId: params.orgId,
      cloudRegion: env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION ?? "DEV",
    },
    current_period_start: 1_700_000_000,
    items: {
      data: [
        {
          current_period_start: 1_700_000_000,
          price: {
            id: STRIPE_PRO_MONTHLY_PRICE_ID,
            product: "prod_litefuse_pro",
          },
        },
        {
          current_period_start: 1_700_000_000,
          price: {
            id: STRIPE_USAGE_PRICE_ID,
            product: "prod_litefuse_usage",
          },
        },
        ...(params.team
          ? [
              {
                current_period_start: 1_700_000_000,
                price: {
                  id: STRIPE_TEAMS_MONTHLY_ADDON_PRICE_ID,
                  product: "prod_litefuse_teams",
                },
              },
            ]
          : []),
      ],
    },
  } as unknown as Stripe.Subscription;
}

describe("Litefuse Pro billing", () => {
  it("builds the Pro catalogue from configured price ids", () => {
    expect(getBillingCatalogue()).toEqual([
      expect.objectContaining({
        plan: "cloud:pro",
        priceIds: [STRIPE_PRO_MONTHLY_PRICE_ID, STRIPE_USAGE_PRICE_ID],
      }),
    ]);
  });

  it("builds fixed and metered Checkout line items", () => {
    expect(getCheckoutLineItems("cloud:pro")).toEqual([
      { price: STRIPE_PRO_MONTHLY_PRICE_ID, quantity: 1 },
      { price: STRIPE_USAGE_PRICE_ID },
    ]);
  });

  it("does not expose Teams as a self-service target", () => {
    expect(billingTargetPlanSchema.safeParse("cloud:team").success).toBe(false);
    expect(getBillingCatalogue().map((entry) => entry.plan)).toEqual([
      "cloud:pro",
    ]);
  });

  it("rejects product ids in Pro price configuration", () => {
    const originalMonthlyPriceId = env.STRIPE_PRO_MONTHLY_PRICE_ID;
    const originalTeamsPriceId = env.STRIPE_TEAMS_MONTHLY_ADDON_PRICE_ID;
    const originalUsagePriceId = env.STRIPE_USAGE_PRICE_ID;

    Object.assign(env, {
      STRIPE_PRO_MONTHLY_PRICE_ID: "prod_litefuse_pro",
      STRIPE_TEAMS_MONTHLY_ADDON_PRICE_ID: undefined,
      STRIPE_USAGE_PRICE_ID: undefined,
    });

    try {
      expect(getBillingCatalogue()).toEqual([]);
      expect(getInvalidBillingCatalogueEntries()).toEqual([
        {
          kind: "pro",
          envVar: "STRIPE_PRO_MONTHLY_PRICE_ID",
          value: "prod_litefuse_pro",
        },
      ]);
    } finally {
      Object.assign(env, {
        STRIPE_PRO_MONTHLY_PRICE_ID: originalMonthlyPriceId,
        STRIPE_TEAMS_MONTHLY_ADDON_PRICE_ID: originalTeamsPriceId,
        STRIPE_USAGE_PRICE_ID: originalUsagePriceId,
      });
    }
  });

  it("syncs active and canceled Stripe subscriptions into organization cloudConfig", async () => {
    const { org } = await createBillingOrg();
    const customerId = parseCloudConfig(org.cloudConfig)?.stripe?.customerId!;

    await syncSubscriptionToOrganization(
      createSubscription({
        orgId: org.id,
        customerId,
        status: "active",
        subscriptionId: "sub_active_pro",
      }),
    );

    const activeOrg = await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
    });
    const activeCloudConfig = parseCloudConfig(activeOrg.cloudConfig);
    expect(activeCloudConfig?.plan).toBeUndefined();
    expect(activeCloudConfig?.stripe?.resolvedPlan).toBe("Pro");
    expect(activeCloudConfig?.stripe?.activeSubscriptionId).toBe(
      "sub_active_pro",
    );
    expect(activeCloudConfig?.stripe?.activeProductId).toBe(
      "prod_litefuse_pro",
    );
    expect(getOrganizationPlanServerSide(activeCloudConfig ?? undefined)).toBe(
      "cloud:pro",
    );

    await syncSubscriptionToOrganization(
      createSubscription({
        orgId: org.id,
        customerId,
        status: "canceled",
        subscriptionId: "sub_active_pro",
      }),
      true,
    );

    const canceledOrg = await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
    });
    const canceledCloudConfig = parseCloudConfig(canceledOrg.cloudConfig);
    expect(canceledCloudConfig?.stripe?.resolvedPlan).toBeNull();
    expect(canceledCloudConfig?.stripe?.activeSubscriptionId).toBeNull();
    expect(
      getOrganizationPlanServerSide(canceledCloudConfig ?? undefined),
    ).toBe("cloud:hobby");
  });

  it("keeps Pro on past_due subscriptions", async () => {
    const { org } = await createBillingOrg();
    const customerId = parseCloudConfig(org.cloudConfig)?.stripe?.customerId!;

    await syncSubscriptionToOrganization(
      createSubscription({
        orgId: org.id,
        customerId,
        status: "past_due",
      }),
    );

    const updatedOrg = await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
    });
    const cloudConfig = parseCloudConfig(updatedOrg.cloudConfig);
    expect(cloudConfig?.stripe?.resolvedPlan).toBe("Pro");
    expect(cloudConfig?.stripe?.subscriptionStatus).toBe("past_due");
  });

  it("resolves Teams only when the addon is present", async () => {
    const { org } = await createBillingOrg();
    const customerId = parseCloudConfig(org.cloudConfig)?.stripe?.customerId!;

    await syncSubscriptionToOrganization(
      createSubscription({
        orgId: org.id,
        customerId,
        status: "trialing",
        team: true,
      }),
    );

    const updatedOrg = await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
    });
    const cloudConfig = parseCloudConfig(updatedOrg.cloudConfig);
    expect(cloudConfig?.plan).toBeUndefined();
    expect(cloudConfig?.stripe?.resolvedPlan).toBe("Team");
    expect(cloudConfig?.stripe?.activeTeamsAddonProductId).toBe(
      "prod_litefuse_teams",
    );
    expect(getOrganizationPlanServerSide(cloudConfig ?? undefined)).toBe(
      "cloud:team",
    );
  });

  it.each(["unpaid", "canceled", "incomplete_expired"] as const)(
    "removes paid access for %s subscriptions",
    async (status) => {
      const { org } = await createBillingOrg();
      const customerId = parseCloudConfig(org.cloudConfig)?.stripe?.customerId!;

      await syncSubscriptionToOrganization(
        createSubscription({ orgId: org.id, customerId, status }),
      );

      const updatedOrg = await prisma.organization.findUniqueOrThrow({
        where: { id: org.id },
      });
      const cloudConfig = parseCloudConfig(updatedOrg.cloudConfig);
      expect(cloudConfig?.stripe?.resolvedPlan).toBeNull();
      expect(cloudConfig?.stripe?.activeSubscriptionId).toBeNull();
      expect(getOrganizationPlanServerSide(cloudConfig ?? undefined)).toBe(
        "cloud:hobby",
      );
    },
  );

  it("does not reset cycle usage for repeated subscription events", async () => {
    const { org } = await createBillingOrg();
    const customerId = parseCloudConfig(org.cloudConfig)?.stripe?.customerId!;
    const subscription = createSubscription({
      orgId: org.id,
      customerId,
      status: "active",
    });

    await syncSubscriptionToOrganization(subscription);
    await prisma.organization.update({
      where: { id: org.id },
      data: { cloudCurrentCycleUsage: 42_000 },
    });
    await syncSubscriptionToOrganization(subscription);

    await expect(
      prisma.organization.findUniqueOrThrow({ where: { id: org.id } }),
    ).resolves.toMatchObject({ cloudCurrentCycleUsage: 42_000 });
  });

  it("ignores subscriptions from another cloud region", async () => {
    const { org } = await createBillingOrg();
    const customerId = parseCloudConfig(org.cloudConfig)?.stripe?.customerId!;
    const subscription = createSubscription({
      orgId: org.id,
      customerId,
      status: "active",
    });
    subscription.metadata.cloudRegion = "another-region";

    await expect(syncSubscriptionToOrganization(subscription)).resolves.toEqual(
      { orgId: null, planChanged: false },
    );
    const unchangedOrg = await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(
      parseCloudConfig(unchangedOrg.cloudConfig)?.stripe?.resolvedPlan,
    ).toBeUndefined();
  });

  it("processes Stripe webhooks idempotently", async () => {
    const { org } = await createBillingOrg();
    const customerId = parseCloudConfig(org.cloudConfig)?.stripe?.customerId!;
    const event = {
      id: `evt_${uuidv4()}`,
      object: "event",
      api_version: "2025-01-27.acacia",
      created: 1_700_000_000,
      data: {
        object: createSubscription({
          orgId: org.id,
          customerId,
          status: "active",
        }),
      },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "customer.subscription.updated",
    };
    const payload = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: STRIPE_WEBHOOK_SECRET,
    });

    await expect(
      handleStripeWebhook({ rawBody: payload, signature }),
    ).resolves.toEqual({ received: true, duplicate: false });
    await expect(
      handleStripeWebhook({ rawBody: payload, signature }),
    ).resolves.toEqual({ received: true, duplicate: true });

    await expect(
      prisma.stripeWebhookEvent.count({
        where: { stripeEventId: event.id },
      }),
    ).resolves.toBe(1);
  });

  it("retries a webhook event after a failed attempt", async () => {
    const { org } = await createBillingOrg();
    const customerId = parseCloudConfig(org.cloudConfig)?.stripe?.customerId!;
    const event = {
      id: `evt_${uuidv4()}`,
      object: "event",
      api_version: "2025-01-27.acacia",
      created: 1_700_000_000,
      data: {
        object: createSubscription({
          orgId: org.id,
          customerId,
          status: "active",
        }),
      },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "customer.subscription.updated",
    };
    await prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        eventType: event.type,
        status: "failed",
        error: "temporary failure",
      },
    });
    const payload = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: STRIPE_WEBHOOK_SECRET,
    });

    await expect(
      handleStripeWebhook({ rawBody: payload, signature }),
    ).resolves.toEqual({ received: true, duplicate: false });
    await expect(
      prisma.stripeWebhookEvent.findUniqueOrThrow({
        where: { stripeEventId: event.id },
      }),
    ).resolves.toMatchObject({ status: "processed", error: null });
  });

  it("does not claim a webhook that has a live processing lease", async () => {
    const { org } = await createBillingOrg();
    const customerId = parseCloudConfig(org.cloudConfig)?.stripe?.customerId!;
    const event = {
      id: `evt_${uuidv4()}`,
      object: "event",
      api_version: "2025-01-27.acacia",
      created: 1_700_000_000,
      data: {
        object: createSubscription({
          orgId: org.id,
          customerId,
          status: "active",
        }),
      },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "customer.subscription.updated",
    };
    await prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        eventType: event.type,
        status: "processing",
      },
    });
    const payload = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: STRIPE_WEBHOOK_SECRET,
    });

    await expect(
      handleStripeWebhook({ rawBody: payload, signature }),
    ).resolves.toEqual({ received: true, duplicate: true });
    const unchangedOrg = await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(
      parseCloudConfig(unchangedOrg.cloudConfig)?.stripe?.resolvedPlan,
    ).toBeUndefined();
  });

  it("allows owners and rejects members for billing status", async () => {
    const ownerFixture = await createBillingOrg(Role.OWNER);
    const ownerCaller = createCaller(
      createSession({ ...ownerFixture, role: Role.OWNER }),
    );
    await expect(
      ownerCaller.billing.getBillingStatus({ orgId: ownerFixture.org.id }),
    ).resolves.toMatchObject({
      plan: "cloud:hobby",
    });

    const memberFixture = await createBillingOrg(Role.MEMBER);
    const memberCaller = createCaller(
      createSession({ ...memberFixture, role: Role.MEMBER }),
    );
    await expect(
      memberCaller.billing.getBillingStatus({ orgId: memberFixture.org.id }),
    ).rejects.toThrow("Forbidden");
  });

  it("marks manual plan overrides as non-self-service", async () => {
    const fixture = await createBillingOrg(Role.OWNER);
    await prisma.organization.update({
      where: { id: fixture.org.id },
      data: {
        cloudConfig: {
          plan: "Enterprise",
          stripe: { customerId: `cus_${uuidv4()}` },
        },
      },
    });
    const caller = createCaller(
      createSession({ ...fixture, role: Role.OWNER }),
    );

    await expect(
      caller.billing.getBillingStatus({ orgId: fixture.org.id }),
    ).resolves.toMatchObject({
      plan: "cloud:enterprise",
      isManualPlanOverride: true,
    });
  });
});
