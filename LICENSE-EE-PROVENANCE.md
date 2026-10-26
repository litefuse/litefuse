# Provenance note for the enterprise modules (LICENSE-EE, ANNEX A)

This note records what is **established** about the provenance of the paths in
ANNEX A of `LICENSE-EE`, what is **not** established, and what would settle it.
It exists because ANNEX C deliberately no longer asserts that those files are
independently authored.

> Status: **open**. The evidence below measures text overlap. It does not, and
> cannot, establish authorship of material that was previously adapted from
> licensed code.

## 1. What is established

- The Litefuse core outside ANNEX A is derived from the MIT-licensed Langfuse
  core and remains MIT (`/LICENSE`).
- Langfuse's commercial boundary is directory-based (`ee/`, `web/src/ee/`,
  `worker/src/ee/`). None of those directories exists in this repository. The
  ANNEX A paths implement the same feature areas, so the interfaces they must
  satisfy — route and hook signatures, database call shapes, provider
  identifiers, protocol-fixed values — are necessarily the same.
- Commit `5fb90ea` ("refactor: implement the enterprise modules independently of
  Langfuse's commercial edition") rewrote 32 files. Its own message states that
  material adapted from upstream commercial code was changed by altering wording,
  helper decomposition, control flow and naming.

## 2. What is NOT established

Reduced verbatim overlap is **not** evidence of independent authorship.
Re-wording, re-organising or renaming parts of a derivative work does not create
rights in the pre-existing material, and it does not remove the original
license from it. For several files the change is smaller than that: only a
user-visible response string was replaced, and the file is otherwise the same
implementation.

## 3. How the numbers below were produced

Method (same as the one used to review the rewrite; `MIN_LEN` is the only
parameter):

1. "Substantial line" = `line.trim()` of at least 40 characters that does not
   start with `import `, `//` or `*`.
2. Upstream commercial set = paths under `ee/`, `web/src/ee/`, `worker/src/ee/`
   in `langfuse/langfuse` at `main` = `0ea9fde` (v4.58.0).
3. A local line counts as shared only if it appears in the commercial set, in at
   most 4 of those files, and **not** anywhere in upstream's MIT core (the core
   exclusion keeps framework boilerplate from being counted).
4. Change classification is a heuristic over the commit diff: a file is
   `string-only` when every changed line pair differs only inside string
   literals. It separates "re-worded" from "restructured" and is not a legal
   classification.

Re-run with:

```bash
node recheck-derivation.mjs <repo> <upstream> --leftovers     # overlap
node provenance-report.mjs <repo> <upstream> 5fb90ea          # this table
```

## 4. Evidence

| file | residual shared lines | change | -/+ lines |
| --- | --- | --- | --- |
| `web/src/__tests__/server/memberships-api.servertest.ts` | 0 | string-only (1 string-only) | -1/+1 |
| `web/src/__tests__/server/organizations-api.servertest.ts` | 0 | string-only (1 string-only) | -1/+1 |
| `web/src/__tests__/server/projects-api.servertest.ts` | 0 | mixed (4 string-only) | -7/+11 |
| `web/src/components/BatchExportTableButton.tsx` | 0 | string-only (1 string-only) | -1/+1 |
| `web/src/components/SupportOrUpgradePage.tsx` | 0 | mixed (2 string-only) | -8/+8 |
| `web/src/features/audit-logs/AuditLogsSettingsPage.tsx` | 0 | structural | -10/+9 |
| `web/src/features/audit-logs/AuditLogsTable.tsx` | 0 | structural | -55/+77 |
| `web/src/features/audit-logs/OrgAuditLogsSettingsPage.tsx` | 0 | structural | -10/+9 |
| `web/src/features/billing/server/billingService.ts` | 0 | structural | -16/+37 |
| `web/src/features/enterprise/apiKeys/createProjectApiKey.ts` | 0 | structural | -20/+38 |
| `web/src/features/enterprise/apiKeys/deleteOrgApiKey.ts` | 0 | structural | -12/+18 |
| `web/src/features/enterprise/apiKeys/deleteProjectApiKey.ts` | 0 | structural | -11/+17 |
| `web/src/features/enterprise/memberships/deleteOrgMembership.ts` | 0 | string-only (1 string-only) | -1/+1 |
| `web/src/features/enterprise/memberships/deleteProjectMembership.ts` | 0 | string-only (1 string-only) | -1/+1 |
| `web/src/features/enterprise/memberships/listProjectMemberships.ts` | 0 | structural | -18/+15 |
| `web/src/features/enterprise/memberships/upsertProjectMembership.ts` | 0 | structural | -20/+20 |
| `web/src/features/enterprise/organizations/createOrganization.ts` | 0 | structural | -25/+58 |
| `web/src/features/enterprise/organizations/deleteOrganization.ts` | 0 | structural | -15/+25 |
| `web/src/features/enterprise/organizations/listOrganizations.ts` | 0 | structural | -5/+7 |
| `web/src/features/enterprise/organizations/updateOrganization.ts` | 0 | structural | -26/+61 |
| `web/src/features/enterprise/projects/createProject.ts` | 0 | structural | -53/+91 |
| `web/src/features/enterprise/projects/deleteProject.ts` | 0 | mixed (2 string-only) | -19/+19 |
| `web/src/features/enterprise/projects/updateProject.ts` | 0 | structural | -63/+103 |
| `web/src/features/enterprise/sso/createSsoConfig.ts` | 1 | structural | -23/+31 |
| `web/src/features/enterprise/sso/ssoConfigSchema.ts` | 0 | structural | -118/+85 |
| `web/src/features/enterprise/sso/ssoProviders.ts` | 0 | structural | -35/+39 |
| `web/src/server/adminApiAuth.ts` | 0 | structural | -62/+51 |
| `worker/src/features/billing/usageMetering.ts` | 0 | structural | -19/+21 |
| `worker/src/features/billing/usageThresholds.ts` | 1 | structural | -10/+14 |

string-only classification (needs provenance resolution, not a line count):
  - web/src/__tests__/server/memberships-api.servertest.ts
  - web/src/__tests__/server/organizations-api.servertest.ts
  - web/src/components/BatchExportTableButton.tsx
  - web/src/features/enterprise/memberships/deleteOrgMembership.ts
  - web/src/features/enterprise/memberships/deleteProjectMembership.ts

Reading of the table:

- **Residual shared lines** is at most 1 for every file, and the leftovers are
  framework idioms (a Prisma call shape, a `<Dialog open={open} …>` line, a
  generic 500 response). That is what the rewrite achieved.
- **Five files are `string-only`** — the change is a re-worded response, nothing
  else:
  - `web/src/components/BatchExportTableButton.tsx`
  - `web/src/features/enterprise/memberships/deleteOrgMembership.ts`
  - `web/src/features/enterprise/memberships/deleteProjectMembership.ts`
  - `web/src/__tests__/server/memberships-api.servertest.ts` (test assertion)
  - `web/src/__tests__/server/organizations-api.servertest.ts` (test assertion)
- The remaining files were changed structurally (helpers split, control flow
  reorganised, naming changed). A larger diff lowers measured overlap; it does not
  by itself answer the provenance question.
- Every file listed above was touched by `5fb90ea`, i.e. it belongs to the set
  that the commit message describes as adapted from the licensed code. The table
  therefore bounds the problem; it does not clear any file.

## 5. What would settle it

Either of the following, per file or for the set:

1. **Authorization** — a written license or permission from the Langfuse
   copyright holder (the upstream `ee/LICENSE` identifies the licensor; note that
   upstream's own terms have changed over time) covering these files and the
   distribution of the Software. Record the grant here and in ANNEX C.
2. **Documented independent implementation** — a clean-room process, recorded and
   auditable: derive the required behaviour from the interface and from tests,
   implement it without consulting the licensed source, and keep the record of
   that separation. Only this can support an independent-authorship statement.

Until one of those exists, the interim position is the one ANNEX C states: the
Langfuse Enterprise License continues to apply to any file that is a derivative
of the licensed material, and this repository's own license does not relicense
it.
