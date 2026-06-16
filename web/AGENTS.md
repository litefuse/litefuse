# Codex Guidelines for `web`

This file covers package-local guidance for this package.
Use root [AGENTS.md](../AGENTS.md) for monorepo-level rules.

## Purpose

- Next.js application with UI, tRPC backend, public REST API routes, and
  in-process background processing.
- Primary package for frontend and most request/response surface changes.

## Maintenance Contract

- `AGENTS.md` is a living document.
- Update this file in the same PR when material web-local changes occur:
  - new/renamed web entry points
  - new API route families
  - changed web-specific verification commands
- If the change also affects monorepo workflows or other packages, update root
  `AGENTS.md` too.

## High-Signal Entry Points

- App shell/providers: `src/pages/_app.tsx`
- tRPC context/procedures: `src/server/api/trpc.ts`
- tRPC router registry: `src/server/api/root.ts`
- tRPC routers: `src/server/api/routers/*`, `src/features/*/server/*`
- Public REST API routes: `src/pages/api/public/*`
- Background processing bootstrap: `src/server/background/bootstrap.ts`
- Queue processors and cleaners: `src/server/background/*`
- Feature modules: `src/features/*`
- Reusable UI components: `src/components/*`
- Tests:
  - Server tests: `src/__tests__/server/*.servertest.ts`
  - Client tests: `src/**/*.clienttest.ts(x)`
  - E2E: `src/__e2e__/*`

## Quick Commands

- Dev: `pnpm --filter web run dev`
- Lint: `pnpm --filter web run lint`
- Lint fix: `pnpm --filter web run lint:fix`
- Typecheck: `pnpm --filter web run typecheck`
- Server tests: `pnpm --filter web run test --testPathPatterns="<pattern>"`
- Client tests: `pnpm --filter web run test-client --testPathPatterns="<pattern>"`
- E2E tests: `pnpm --filter web run test:e2e`
- Build: `pnpm --filter web run build`
- Refill queue event: `pnpm --filter web run refill-queue-event`

## Playbooks

### Add/Change tRPC endpoint

1. Implement router/procedure in `src/server/api/routers/*` or
   `src/features/<feature>/server/*`.
2. Register in `src/server/api/root.ts`.
3. Reuse auth/error patterns from `src/server/api/trpc.ts`.
4. Add/adjust server tests under `src/__tests__/server/*`.

### Add/Change public API endpoint

1. Add route in `src/pages/api/public/*`.
2. Define/update contract types in `src/features/public-api/types/*`.
3. Add/adjust server tests in `src/__tests__/server/*`.
4. If API contract changed, update Fern source (`../fern/apis/**`) and regenerate
   outputs (do not hand-edit `../generated/**`).

### Add frontend feature

1. Prefer `src/features/<feature>/*` for feature-local code.
2. Put broadly reusable components in `src/components/*`.
3. Keep server logic near feature server folders when possible.

### Add/Change Queue Processor

1. Update queue schemas/contracts in `../packages/shared/src/server/queues.ts`
   if payload or queue type changes.
2. Update queue accessors/helpers/configs in
   `../packages/shared/src/server/pgboss/*` when needed.
3. Implement/update processor in `src/server/background/queues/*`.
4. Register/gate the processor in `src/server/background/bootstrap.ts` and
   scheduled jobs in `src/server/background/queues/pgBossScheduledJobs.ts`.
5. Reuse existing `QUEUE_CONSUMER_*` flags and concurrency env patterns.

## Package-Specific Rules

- Router style is Pages Router-centric; follow existing routing patterns.
- Project UI route entry points should live under `src/pages/**`; avoid adding
  duplicate `src/app/**` routes for the same path.
- Keep tests independent; no reliance on test execution order.
- In `src/__tests__/server`, avoid `pruneDatabase` calls.
- Confirm the target `*.clienttest.*` or `*.servertest.*` file exists before using `--testPathPatterns`; source files do not always have a matching colocated test file.
- Do not hand-edit build artifacts: `.next/*`, `.next-check/*`, `dist/*`.
