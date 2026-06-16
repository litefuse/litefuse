# Web and Worker Single-Process Migration

## Summary

This change merges the former standalone `worker` process into the `web`
process. The application now uses a single deployable runtime for both HTTP
traffic and background processing.

Before this change, Langfuse ran two application processes:

```text
web
- Next.js UI
- tRPC and public REST APIs
- public health and readiness endpoints

worker
- queue consumers
- scheduled jobs
- cleaners
- background migrations
- worker startup sync scripts
- worker-only Express health and readiness endpoints
```

After this change, background processing is started inside the `web` process:

```text
web
- Next.js UI
- tRPC and public REST APIs
- public health and readiness endpoints
- queue consumers
- scheduled jobs
- cleaners
- background migrations
- startup sync scripts
```

The old standalone worker service, Docker image, Express shell, and port `3030`
are removed. Queue contracts and pg-boss helpers remain owned by
`@langfuse/shared`.

## What Changed

### Runtime Entry Point

A new background bootstrap module was added:

```text
web/src/server/background/bootstrap.ts
```

It exposes:

```ts
startBackgroundProcessing();
stopBackgroundProcessing();
```

`startBackgroundProcessing()` registers queue consumers, scheduled jobs,
cleaners, background migrations, and worker startup sync scripts.

`stopBackgroundProcessing()` stops cleaners, clears worker registration state,
stops pg-boss, aborts active background migrations, and releases tokenizer
resources.

### Startup

Background processing now starts from:

```text
web/src/instrumentation.ts
```

The startup path only runs when:

```ts
process.env.NEXT_RUNTIME === "nodejs"
```

This avoids starting background consumers in unsupported runtimes. The bootstrap
also uses a process-global singleton guard so Next.js development reloads do not
register queue consumers repeatedly in the same process.

### Shutdown

Shutdown handling remains in:

```text
web/src/utils/shutdown.ts
```

On `SIGTERM` or `SIGINT`, the web process now:

1. Marks readiness as failing immediately.
2. Stops background processing.
3. Keeps the existing web request drain window.
4. Closes shared resources such as Doris, Redis, and Prisma.

This means user-facing readiness flips before shared resources are closed, while
background processing is stopped as part of the same web-process shutdown.

### Environment

Worker queue flags and runtime settings moved into:

```text
web/src/env.mjs
```

Existing queue flags are preserved, for example:

```env
QUEUE_CONSUMER_TRACE_UPSERT_QUEUE_IS_ENABLED
QUEUE_CONSUMER_OBSERVATION_UPSERT_QUEUE_IS_ENABLED
QUEUE_CONSUMER_CREATE_EVAL_QUEUE_IS_ENABLED
QUEUE_CONSUMER_EVAL_EXECUTION_QUEUE_IS_ENABLED
QUEUE_CONSUMER_WEBHOOK_QUEUE_IS_ENABLED
QUEUE_CONSUMER_ENTITY_CHANGE_QUEUE_IS_ENABLED
QUEUE_CONSUMER_NOTIFICATION_QUEUE_IS_ENABLED
```

A new global kill switch was added:

```env
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=true
```

When set to `false`, the web process serves HTTP traffic but does not start
background consumers, scheduled jobs, cleaners, background migrations, or
startup sync scripts.

This is the key control for deployments that want web-only replicas.

### Package and Workspace Layout

The standalone `worker` package was removed from:

```text
pnpm-workspace.yaml
package.json scripts
turbo.json
release-it package bump list
```

The old root development command for the worker was removed:

```text
pnpm run dev:worker
```

The web package now owns the moved operational scripts, for example:

```text
pnpm --filter web run refill-queue-event
```

### Docker and Compose

The standalone worker image and service were removed from compose files:

```text
docker-compose.yml
docker-compose.build.yml
docker-compose.doris.yml
docker-litefuse-doris/docker-compose.yml
docker-litefuse-doris/docker-compose.dev.yml
```

The removed public/runtime interfaces are:

```text
langfuse-worker Docker image
worker service
worker port 3030
worker /api/health
worker /api/ready
```

The preserved health and readiness interfaces are:

```text
/api/public/health
/api/public/ready
```

## What the Old Worker Did

The old worker process was not user-facing business UI. It was the background
runtime for asynchronous and scheduled work.

### Queue Consumers

The worker consumed pg-boss queues such as:

```text
TraceUpsert
ObservationUpsert
CreateEvalQueue
EvaluationExecution
EvaluationExecutionSecondaryQueue
LLMAsJudgeExecution
DatasetRunItemUpsert
BatchActionQueue
CloudUsageMeteringQueue
CloudSpendAlertQueue
CloudFreeTierUsageThresholdQueue
ExperimentCreate
PostHogIntegrationQueue
PostHogIntegrationProcessingQueue
MixpanelIntegrationQueue
MixpanelIntegrationProcessingQueue
BlobStorageIntegrationQueue
DataRetentionQueue
DataRetentionProcessingQueue
DeadLetterRetryQueue
WebhookQueue
EntityChangeQueue
NotificationQueue
TraceDelete
ScoreDelete
DatasetDelete
ProjectDelete
CoreDataS3ExportQueue
MeteringDataPostgresExportQueue
```

These consumers now register from `web/src/server/background/bootstrap.ts`.

### Scheduled Jobs

The worker registered pg-boss schedules for recurring work such as:

```text
cloud usage metering
free-tier usage threshold checks
PostHog integration sync
Mixpanel integration sync
blob storage integration sync
data retention
core data S3 export
metering data Postgres export
dead-letter queue retry
```

The schedule definitions continue to live in `@langfuse/shared`. The web
background runtime now asks shared pg-boss helpers to ensure the enabled
schedules.

### Cleaners

The worker started periodic cleaners such as:

```text
BatchProjectCleaner
BatchDataRetentionCleaner
MediaRetentionCleaner
BatchProjectMediaCleaner
BatchTraceDeletionCleaner
```

These cleaners now run inside the web background runtime.

### Background Migrations

The worker ran background migrations by polling the database, acquiring a lock,
executing the migration script, heartbeating while active, and marking the
migration as finished or failed.

That manager now lives under:

```text
web/src/server/background/backgroundMigrations
```

### Startup Data Sync

The worker previously ran startup sync scripts for:

```text
default model prices
managed evaluators
Langfuse dashboards
```

These now run during web background startup.

### Worker HTTP Shell

The old worker also had an Express HTTP shell used only for worker health and
readiness. This was removed. Background processing no longer exposes a separate
HTTP service.

## What Was Mostly Not Changed

This migration is primarily a runtime and ownership change. It is not intended
to rewrite background business logic.

Mostly unchanged:

```text
queue payload schemas
queue names
pg-boss queue contracts
processor behavior
cleaner behavior
background migration behavior
webhook/eval/delete/integration job business logic
```

Changed meaningfully:

```text
process boundary
startup entry point
shutdown path
health/readiness ownership
Docker and compose topology
workspace/package ownership
environment validation location
```

In short: most job logic moved; the operational model changed.

## New Runtime Model

By default, every web process starts background processing:

```env
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=true
```

This means scaling web replicas can also scale background consumers unless the
environment disables background processing on some replicas.

For deployments that need web-only replicas:

```env
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=false
```

## Recommended Production Topology

Even though there is only one deployable application runtime, production
deployments should still consider separating roles by environment variables.

Recommended topology:

```text
langfuse-web deployment
- uses the web image
- receives user HTTP traffic
- LITEFUSE_BACKGROUND_PROCESSING_ENABLED=false

langfuse-background deployment
- uses the same web image
- does not receive external user traffic
- LITEFUSE_BACKGROUND_PROCESSING_ENABLED=true
- runs queue consumers, schedules, cleaners, and migrations
```

This keeps the deployment artifact simple while preserving operational
separation between user-facing HTTP traffic and background work.

For small self-hosted deployments, a single `langfuse-web` service with
background processing enabled is acceptable and much simpler.

## Advantages

### Simpler Deployment

There is one less service to define, run, monitor, and upgrade. Self-hosted
compose files no longer need a separate `langfuse-worker` service or port
`3030`.

### Fewer Configuration Mismatches

Previously both web and worker needed many of the same settings: database,
Redis, Doris, S3, Stripe, queue flags, and related credentials. A misconfigured
worker could make the UI appear healthy while background work silently failed.

After this change, the web runtime owns both HTTP and background configuration.

### Stronger Version Alignment

The web APIs and background consumers now come from the same image and code
version. This reduces the risk of web producing a queue payload that an older
worker image does not understand.

### Easier Local Development

For local development, one `web` process can now cover the UI, APIs, and
background consumers. Developers no longer need to remember to start a separate
worker process for queue behavior.

### Less Operational Surface Area

The old worker Express app, middleware, health endpoints, Dockerfile, entrypoint,
and package scripts are gone. There are fewer process-specific files to maintain.

## Disadvantages and Risks

### Resource Contention

When background processing runs in the same process as web traffic, queue jobs
and HTTP requests share process resources.

Potential contention points:

```text
CPU
memory
event loop latency
database connections
Doris connections
Redis connections
S3 bandwidth
Stripe/API rate limits
```

This can affect API latency if high-volume background work runs on the same
replicas that serve users.

### Failure Domain Is Larger

Previously, a worker-only failure could leave web traffic available. After this
change, a severe background runtime bug in a background-enabled web process can
affect that whole web process.

Using web-only replicas with `LITEFUSE_BACKGROUND_PROCESSING_ENABLED=false`
reduces this risk for user-facing traffic.

### Scaling Semantics Change

Before:

```text
scale web    -> more HTTP capacity
scale worker -> more background capacity
```

After:

```text
scale web with background enabled -> more HTTP and more background capacity
scale web with background disabled -> more HTTP capacity only
```

Deployments must be explicit about which replicas should run background work.

### Release and Restart Behavior

A web restart can now also restart background processing if that replica has
background processing enabled.

Possible effects:

```text
webhook delivery delay
eval execution delay
batch export interruption and retry
cleaner interruption
background migration abort and later retry
integration sync delay
```

pg-boss jobs are expected to recover through queue semantics, locking, retry,
and reprocessing. However, long-running jobs and migrations still need careful
idempotency and retry behavior.

### Shutdown Requires Care

Shutdown now coordinates both user-facing request drain and background worker
stop in the same process. Readiness should fail immediately so load balancers
stop routing new user traffic, but background processing should also avoid
leaving long-running jobs in ambiguous states.

The current implementation stops background processing during web shutdown.
For production, consider whether a configurable background drain timeout is
needed before force-stopping active jobs.

## Operational Guidance

### Small Deployments

Use one web service:

```env
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=true
```

This is the simplest deployment shape.

### Larger Deployments

Use two deployments with the same image:

```text
web-only replicas:
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=false

background-enabled replicas:
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=true
```

Only route external user traffic to the web-only deployment. Keep
background-enabled replicas internal.

### Queue Concurrency

Review queue concurrency settings before increasing the number of
background-enabled replicas. More replicas may increase total queue throughput
and shared resource pressure.

Important categories:

```text
eval execution concurrency
trace/observation upsert concurrency
webhook concurrency
entity change concurrency
delete queue concurrency
project deletion concurrency
integration processing rate limits
```

### Migrations

Background migrations should usually run on a small number of
background-enabled replicas. Avoid enabling background processing on every web
replica if migrations are expensive or operationally sensitive.

### Health and Readiness

Do not use the removed worker endpoints:

```text
/api/health
/api/ready
port 3030
```

Use the web endpoints:

```text
/api/public/health
/api/public/ready
```

### Rollouts

For production rollouts:

1. Roll web-only replicas first.
2. Confirm public health and readiness.
3. Roll background-enabled replicas.
4. Watch queue depth, failed jobs, database load, Doris load, and webhook/eval
   latency.

This avoids coupling user-facing rollout success to background queue catch-up.

## Compatibility Notes

Removed public/runtime interfaces:

```text
langfuse-worker image
worker service
worker package
worker Dockerfile
worker entrypoint
worker port 3030
worker health endpoint
worker readiness endpoint
pnpm run dev:worker
```

Preserved interfaces:

```text
queue names
queue payload schemas
QUEUE_CONSUMER_* flags
worker concurrency env names
web /api/public/health
web /api/public/ready
```

Added interface:

```text
LITEFUSE_BACKGROUND_PROCESSING_ENABLED
```

## Verification Performed

The migration was validated with:

```text
pnpm --filter @langfuse/shared run build
pnpm --filter web exec eslint src/server/background --max-warnings 0 --no-cache
pnpm --filter web run typecheck
pnpm run build:check
docker compose -f docker-compose.yml config
docker compose -f docker-compose.build.yml config
docker compose -f docker-compose.doris.yml config
docker compose -f docker-litefuse-doris/docker-compose.yml config
docker compose -f docker-litefuse-doris/docker-compose.dev.yml config
```

The full web lint command needs separate cleanup because the broader `web/src`
tree currently contains unrelated existing warnings outside the migrated
background runtime.

## Follow-Up Work

Recommended follow-ups:

1. Move or recreate the most important worker Vitest coverage under the web
   package.
2. Add a `web` script such as `test:background` for migrated background tests.
3. Add runtime smoke tests for pg-boss queue consumption from the web process.
4. Document the recommended production topology in deployment docs.
5. Consider adding a configurable background shutdown drain timeout.
6. Review queue concurrency defaults for deployments that run multiple
   background-enabled web replicas.
7. Add monitoring guidance for queue depth, failed jobs, retry counts, and
   background processing latency.

