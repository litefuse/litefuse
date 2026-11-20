# Codex Guidelines for `web`

This file covers package-local guidance for this package.
Use root [AGENTS.md](../AGENTS.md) for monorepo-level rules.

## Purpose

- Next.js 15 application with UI, tRPC backend, and public REST API routes.
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
- Feature modules: `src/features/*`
- Cloud billing service, router, and UI: `src/features/billing/*`
- Stripe webhook: `src/app/api/billing/stripe-webhook/route.ts`
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

### Change cloud billing

1. Keep Stripe catalogue, lifecycle, and webhook behavior in
   `src/features/billing/server/*`.
2. Preserve the separation between manual `cloudConfig.plan` overrides and
   webhook-resolved `cloudConfig.stripe.resolvedPlan`.
3. Add lifecycle/webhook regression coverage in
   `src/__tests__/server/billing-pro.servertest.ts`.

## Package-Specific Rules

- Router style is Pages Router-centric; follow existing routing patterns.
- Project UI route entry points should live under `src/pages/**`; avoid adding
  duplicate `src/app/**` routes for the same path.
- Keep tests independent; no reliance on test execution order.
- In `src/__tests__/server`, avoid `pruneDatabase` calls.
- Confirm the target `*.clienttest.*` or `*.servertest.*` file exists before using `--testPathPatterns`; source files do not always have a matching colocated test file.
- Do not hand-edit build artifacts: `.next/*`, `.next-check/*`, `dist/*`.
- Next.js and `typecheck` use `tsconfig.build.json` to exclude tests from
  production typechecking. Keep this aligned: Docker prunes the worker package,
  which may contain fixtures imported by web tests.
- Node initialization must await the first Doris split-cache snapshot before
  request handlers can issue telemetry queries. Cross-project server features
  pass explicit active project IDs to shared aggregation repositories.
- Discover's tRPC query entry point compiles browser SQL through
  `src/features/discover/server/readQuery.ts` before calling Doris. Keep
  database and table authorization shared with the structured metadata routes.

## Enterprise SSO logout

- Per-enterprise logout settings live in `SsoConfig.authConfig.logout`; use URL
  and parameter mappings, not vendor-specific branches.
- The session JWT records the actual login provider. Store a bounded ID token
  only when the logout mapping uses it, bound to the login's IdP/client. Do not
  expose these fields in the client Session or infer the provider from an email.
- `GET /api/auth/sso-logout` prepares the current browser's logout URL;
  `signOutWithSso` must finish NextAuth's CSRF-protected local sign-out before
  navigating to the IdP. Suspend guard navigation during explicit user logout;
  automatic cleanup must remain local. IdP preparation failure must still allow
  local logout with a visible error. Invalid logout settings must not remove a
  provider from the provider list. Omit unavailable hints unless `requireIdToken`
  is configured; never let a large hint inflate the session cookie without bounds.
- Preserve pre-upgrade sessions, including password sessions. Record SSO identity
  only on a completed login; session reads and client-triggered updates must not
  infer a provider or accept caller-supplied SSO fields. Legacy sessions migrate
  through logout, login, logout, login: the first logout is local, the intervening
  login records the provider, and the second logout can end the IdP session.
  Do not introduce forced reauthentication or session-version invalidation for
  this rollout. See the README for the accepted first-cycle limitation.
- `PATCH /api/auth/sso-logout-config` requires the instance admin API key and
  updates only logout settings. See `src/features/enterprise/sso/README.md`.
- Focused checks: `pnpm --filter web run test-client --runInBand --testPathPatterns='/(sso[^/]*|signOutWithSso|updateSsoLogoutConfig|signOut)[.]clienttest[.](ts|tsx)$'`.
