# Cloud billing operations

The Stripe webhook is implemented in
`web/src/app/api/billing/stripe-webhook/route.ts`. Organization billing actions
are exposed through the billing tRPC router in
`web/src/features/billing/server/billingRouter.ts`.

## Stripe catalogue

Create the following monthly prices in every Stripe account/region:

- `STRIPE_PRO_MONTHLY_PRICE_ID`: $199/month recurring Pro base price.
- `STRIPE_TEAMS_MONTHLY_ADDON_PRICE_ID`: $300/month recurring Teams add-on,
  retained for existing subscription and webhook compatibility. Teams is not
  currently exposed as a self-service Checkout target.
- `STRIPE_USAGE_PRICE_ID`: metered price for the `litefuse_units` meter. The
  first 200,000 units are free and all later units cost $0.00004 each.

Configure `STRIPE_SECRET_KEY` in web and worker, and
`STRIPE_WEBHOOK_SECRET` in web. Subscribe the webhook endpoint to checkout
session, customer subscription, and invoice payment events. Product IDs are not
accepted in place of Price IDs.

Checkout and subscription metadata must contain `orgId` and `cloudRegion`.
Webhook processing ignores subscriptions belonging to another configured
region. Failed webhook rows are retryable; a processing lease prevents parallel
delivery from applying the event twice.

## Usage processing and rollout

The worker registers two hourly queues:

- `cloud-usage-metering-queue` aggregates trace, observation, and score rows by
  server `created_at`, submits a deterministic Stripe meter event, and stores
  the interval plus its submission checkpoint in `BillingMeterBackup`.
- `cloud-free-tier-usage-threshold-queue` refreshes organization-cycle usage,
  sends the 80k warning, and sets the 100k Developer ingestion block.

Start a deployment with
`LITEFUSE_FREE_TIER_USAGE_THRESHOLD_ENFORCEMENT_ENABLED=false`. This records
usage without warning or blocking. Compare Doris results, Stripe meter summaries,
and `billing_meter_backups` for at least 48 hours before enabling enforcement.
The queue consumers can be controlled independently with
`QUEUE_CONSUMER_CLOUD_USAGE_METERING_QUEUE_IS_ENABLED` and
`QUEUE_CONSUMER_FREE_TIER_USAGE_THRESHOLD_QUEUE_IS_ENABLED`.

Stripe handles taxes, invoices, discounts, and negotiated prices. Enterprise
and self-hosted plans do not use self-service Checkout.
