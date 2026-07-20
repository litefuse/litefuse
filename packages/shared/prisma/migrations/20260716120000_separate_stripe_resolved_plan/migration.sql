-- Move subscription-derived plans written by the initial Litefuse billing
-- implementation into stripe.resolvedPlan. Root-level plan remains reserved
-- for manual overrides.
UPDATE "organizations"
SET "cloud_config" = jsonb_set(
  "cloud_config"::jsonb - 'plan',
  '{stripe,resolvedPlan}',
  to_jsonb("cloud_config"::jsonb ->> 'plan'),
  true
)
WHERE "cloud_config"::jsonb -> 'stripe' ->> 'activeSubscriptionId' IS NOT NULL
  AND "cloud_config"::jsonb ->> 'plan' IN ('Pro', 'Team');
