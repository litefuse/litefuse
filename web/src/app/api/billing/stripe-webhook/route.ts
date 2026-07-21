import { handleStripeWebhook } from "@/src/features/billing/server/stripeWebhookHandler";
import { logger } from "@langfuse/shared/src/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const result = await handleStripeWebhook({
      rawBody,
      signature: request.headers.get("stripe-signature"),
    });
    return NextResponse.json(result);
  } catch (error) {
    logger.error("Stripe webhook failed", error);
    const isBadRequest =
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "BAD_REQUEST") ||
      (typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "StripeSignatureVerificationError");
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Stripe webhook failed",
      },
      { status: isBadRequest ? 400 : 500 },
    );
  }
}
