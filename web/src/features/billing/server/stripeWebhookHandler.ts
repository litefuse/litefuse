import { env } from "@/src/env.mjs";
import { prisma, type Prisma } from "@langfuse/shared/src/db";
import { logger, traceException } from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";
import type Stripe from "stripe";
import {
  ensureStripeConfigured,
  getStripeClient,
  syncSubscriptionToOrganization,
} from "./billingService";

type WebhookResult = {
  received: true;
  duplicate: boolean;
};

function isDuplicateEventError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

async function claimStripeEvent(event: Stripe.Event): Promise<boolean> {
  try {
    await prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        eventType: event.type,
        status: "processing",
        payload: event as unknown as Prisma.InputJsonValue,
      },
    });
    return true;
  } catch (error) {
    if (!isDuplicateEventError(error)) throw error;
  }

  const existing = await prisma.stripeWebhookEvent.findUniqueOrThrow({
    where: { stripeEventId: event.id },
  });
  if (existing.status === "processed") return false;

  // A concurrent request is already responsible for this event. Stripe may
  // retry a delivery while the first request is still running, so only reclaim
  // a processing event after its lease has gone stale.
  const processingLeaseCutoff = new Date(Date.now() - 5 * 60 * 1000);
  if (
    existing.status === "processing" &&
    existing.updatedAt > processingLeaseCutoff
  ) {
    return false;
  }

  const claimed = await prisma.stripeWebhookEvent.updateMany({
    where: {
      id: existing.id,
      status: existing.status,
      updatedAt: existing.updatedAt,
    },
    data: {
      status: "processing",
      error: null,
      payload: event as unknown as Prisma.InputJsonValue,
    },
  });
  return claimed.count === 1;
}

function stripeId(
  value: string | { id?: string } | null | undefined,
): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id ?? null;
}

async function getSubscriptionFromInvoice(invoice: Stripe.Invoice) {
  const subscriptionId = stripeId(
    (
      invoice as Stripe.Invoice & {
        subscription?: string | Stripe.Subscription | null;
      }
    ).subscription,
  );
  return subscriptionId
    ? await getStripeClient().subscriptions.retrieve(subscriptionId)
    : null;
}

async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const subscriptionId = stripeId(session.subscription);
      if (!subscriptionId) return;
      const subscription =
        await getStripeClient().subscriptions.retrieve(subscriptionId);
      await syncSubscriptionToOrganization(subscription);
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      await syncSubscriptionToOrganization(
        event.data.object as Stripe.Subscription,
      );
      return;
    }
    case "customer.subscription.deleted": {
      await syncSubscriptionToOrganization(
        event.data.object as Stripe.Subscription,
        true,
      );
      return;
    }
    case "invoice.payment_failed":
    case "invoice.paid": {
      const subscription = await getSubscriptionFromInvoice(
        event.data.object as Stripe.Invoice,
      );
      if (subscription) await syncSubscriptionToOrganization(subscription);
      return;
    }
    default:
      logger.info("Ignoring unsupported Stripe webhook event", {
        eventId: event.id,
        eventType: event.type,
      });
  }
}

export async function handleStripeWebhook(params: {
  rawBody: string | Buffer;
  signature: string | null;
}): Promise<WebhookResult> {
  ensureStripeConfigured("webhook");

  if (!params.signature) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Missing Stripe signature.",
    });
  }

  const event = getStripeClient().webhooks.constructEvent(
    params.rawBody,
    params.signature,
    env.STRIPE_WEBHOOK_SECRET!,
  );

  if (!(await claimStripeEvent(event))) {
    logger.info("Skipping processed Stripe webhook event", {
      eventId: event.id,
      eventType: event.type,
    });
    return { received: true, duplicate: true };
  }

  try {
    await handleStripeEvent(event);
    await prisma.stripeWebhookEvent.update({
      where: { stripeEventId: event.id },
      data: {
        status: "processed",
        processedAt: new Date(),
      },
    });
    return { received: true, duplicate: false };
  } catch (error) {
    traceException(error);
    await prisma.stripeWebhookEvent.update({
      where: { stripeEventId: event.id },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}
