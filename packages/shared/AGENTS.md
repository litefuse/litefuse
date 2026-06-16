# Codex Guidelines for `@langfuse/shared`

This file covers package-local guidance for this package.
Use root [AGENTS.md](../../AGENTS.md) for monorepo-level rules.

## Purpose

- Shared domain, database, queue, and server utilities used by `web`.
- Primary owner of Postgres schema, ClickHouse schema, and queue payload
  contracts.

## Maintenance Contract

- `AGENTS.md` is a living document.
- Update this file in the same PR for material shared-package changes:
  - new/renamed schema or migration workflows
  - new/renamed queue contracts
  - changed exported surfaces or validation commands
- Because this package is consumed by web request paths and background
  processors, cross-package changes usually require updates in root `AGENTS.md`
  too.

## High-Signal Entry Points

- Main exports: `src/index.ts`
- DB clients and types: `src/db.ts`
- Server exports: `src/server/index.ts`
- Domain model types: `src/domain/*`
- Repository layer: `src/server/repositories/*`
- Queue payload schemas: `src/server/queues.ts`
- Queue helpers, configs, and schedule definitions: `src/server/pgboss/*`
- Postgres cache and advisory lock helpers: `src/server/cache/*`
- Postgres schema: `prisma/schema.prisma`
- Prisma migrations: `prisma/migrations/*`
- ClickHouse migrations: `clickhouse/migrations/{clustered,unclustered}/*`
- Seeder and support scripts: `scripts/seeder/*`, `clickhouse/scripts/*`

## Quick Commands

- Dev watch build: `pnpm --filter @langfuse/shared run dev`
- Lint: `pnpm --filter @langfuse/shared run lint`
- Lint fix: `pnpm --filter @langfuse/shared run lint:fix`
- Typecheck: `pnpm --filter @langfuse/shared run typecheck`
- Build: `pnpm --filter @langfuse/shared run build`
- Prisma generate: `pnpm --filter @langfuse/shared run db:generate`
- Prisma migrate (dev): `pnpm --filter @langfuse/shared run db:migrate`
- ClickHouse reset: `pnpm --filter @langfuse/shared run ch:reset`

## Playbooks

### Postgres schema change

1. Update `prisma/schema.prisma`.
2. Add migration in `prisma/migrations/*`.
3. Regenerate client/types via `db:generate`.
4. Update affected repository/query code under `src/server/repositories/*`.
5. Add/adjust `web` tests for changed behavior.

### ClickHouse schema change

1. Add migration under `clickhouse/migrations/*`.
2. Update ClickHouse query/mapping logic in `src/server/clickhouse/*` and
   related repositories.
3. Validate ingestion/read path impact in web request and background paths.

### Queue payload contract change

1. Update zod schemas/types in `src/server/queues.ts`.
2. Update queue helpers/configs in `src/server/pgboss/*` if queue names,
   retry semantics, dedupe, or scheduling changed.
3. Update producer and consumer code in `web`.
4. Add or update regression tests in affected packages.

### Shared cache / lock change

1. Update shared cache helpers in `src/server/cache/*`.
2. Add or update Prisma schema and migration files when cache storage changes.
3. Update affected consumers in `web` and `worker`.
4. Add or update regression tests that verify cache value, TTL, and invalidation
   behavior through Postgres.

### pg-boss schedule change

1. Update schedule definitions and queue configs in `src/server/pgboss/*`.
2. Update background registration/gating in
   `web/src/server/background/bootstrap.ts` and
   `web/src/server/background/queues/pgBossScheduledJobs.ts`.
3. Add or update background tests plus the pg-boss smoke coverage for cron
   pattern, payload, env gating, and queue semantics.

## Package-Specific Rules

- Keep backward compatibility in queue payloads when possible during rolling
  deployments.
- Do not hand-edit generated artifacts under `prisma/generated/*` or `dist/*`.
- Avoid exposing server-only modules through `src/index.ts` if they must remain
  frontend-safe.
