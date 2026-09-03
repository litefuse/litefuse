import { prisma } from "../../db";
import { env } from "../../env";
import { RETENTION_FLOOR_DAYS } from "../../constants";
import { logger } from "../logger";
import { recordIncrement } from "../instrumentation";
import { enqueueDorisSplitTableProvisioning } from "../redis/dorisSplitTableProvisioningQueue";
import { publishSplitCacheInvalidation } from "./tableSplitCache";

/** Free-tier split-table TTL (days), fixed. Retention is a PAID feature — a free
 * org's projects keep this fixed short window regardless of Project.retentionDays. */
export const FREE_RETENTION_DAYS = 30;

/** Paid default TTL (days) when a paid org has set no explicit Project.retentionDays. */
export const PAID_DEFAULT_RETENTION_DAYS = 3 * 365;

/**
 * The effective split-table TTL (days) for a project, derived from PG at
 * provisioning time. Table split is now UNIVERSAL (every project); retention
 * stays a PAID feature (Cloud: Stripe subscription; self-hosted: EE license —
 * both via isOrgPaid), decoupled:
 *   - paid org → Project.retentionDays (user-set); when unset, Cloud falls
 *     back to PAID_DEFAULT_RETENTION_DAYS, self-hosted keeps data indefinitely
 *     (null = no TTL: provisioning materializes it as NO_TTL_START_DAYS and the
 *     group-load retention filter skips the cutoff)
 *   - free org → Cloud: FREE_RETENTION_DAYS (fixed 30d; Project.retentionDays
 *     ignored); self-hosted OSS (no license): null = no TTL
 * Floor-clamped (RETENTION_FLOOR_DAYS). Async (PG read) — call only in async
 * contexts (the provisioning job, the group-load retention filter), NEVER the
 * synchronous isSplitProject hot path.
 */
export const getSplitRetentionDays = async (
  projectId: string,
): Promise<number | null> => {
  const isCloud = Boolean(env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      retentionDays: true,
      organization: { select: { cloudConfig: true } },
    },
  });
  if (!project) return isCloud ? FREE_RETENTION_DAYS : null;

  let raw: number | null;
  if (isOrgPaid(project.organization.cloudConfig)) {
    raw =
      project.retentionDays ?? (isCloud ? PAID_DEFAULT_RETENTION_DAYS : null);
  } else {
    raw = isCloud ? FREE_RETENTION_DAYS : null;
  }
  if (raw === null) return null;
  return raw < RETENTION_FLOOR_DAYS ? RETENTION_FLOOR_DAYS : raw;
};

/**
 * Designate a project for table-split (or update its settings) and trigger
 * provisioning (Stage 1.2b hook). Writes the control row and enqueues the
 * idempotent per-project provisioning job.
 *
 * ORDERING (Stage 1.2 readiness): a project's split must only go LIVE
 * (split=true) once its physical tables exist. So designation defaults to
 * split=false — call this to create the row + kick provisioning, then flip
 * split=true via the readiness gate (Stage 1.2c) once the tables + MV are
 * ready. Passing split=true here is allowed but only safe for a project that is
 * not yet ingesting (provisioned before its first trace).
 *
 * TODO(1.2e): publish a Redis invalidation so every process refreshes its
 * split-cache immediately instead of waiting for the periodic refresh.
 */
export const upsertDorisProjectTableSplit = async (params: {
  projectId: string;
  split?: boolean;
  note?: string | null;
}): Promise<void> => {
  const { projectId, split, note } = params;
  // Retention (split-table TTL) is NOT stored here — it is single-sourced on
  // Project.retentionDays and read (+ floor-clamped) at provisioning time.
  await prisma.dorisProjectTableSplit.upsert({
    where: { projectId },
    update: {
      ...(split !== undefined ? { split } : {}),
      ...(note !== undefined ? { note } : {}),
    },
    create: {
      projectId,
      split: split ?? false,
      note: note ?? null,
    },
  });
  logger.info(
    `[table-split] designated ${projectId} (split=${split ?? false}); enqueuing provisioning`,
  );
  // The control row above is the provisioning/readiness guarantee for the
  // project's lane. Propagation + the provisioning kick are RECOVERABLE
  // (periodic refresh + grouper self-heal / reconcile re-drive them), so a
  // Redis hiccup here must NOT fail the caller (e.g. project creation).
  try {
    await publishSplitCacheInvalidation();
  } catch (e) {
    logger.error(`[table-split] cache invalidation for ${projectId} failed`, e);
  }
  try {
    await enqueueDorisSplitTableProvisioning(projectId);
  } catch (e) {
    logger.error(
      `[table-split] provisioning enqueue for ${projectId} failed`,
      e,
    );
  }
};

/** Remove a project's split designation (control row). Does NOT drop the Doris
 * tables — that is the project-deletion / un-split flow's responsibility. */
export const deleteDorisProjectTableSplit = async (
  projectId: string,
): Promise<void> => {
  await prisma.dorisProjectTableSplit
    .delete({ where: { projectId } })
    .catch(() => undefined); // idempotent — already gone is fine
  await publishSplitCacheInvalidation();
};

/** Paying customer iff cloudConfig has an active Stripe subscription with a
 * resolved paid plan — the same test getPlan.ts uses (activeSubscriptionId &&
 * resolvedPlan). Used by getSplitRetentionDays to pick the paid vs free TTL —
 * table split itself is universal (billing-independent). */
const isOrgPaid = (cloudConfig: unknown): boolean => {
  const stripe = (
    cloudConfig as {
      stripe?: {
        activeSubscriptionId?: string | null;
        resolvedPlan?: string | null;
      };
    } | null
  )?.stripe;
  if (stripe?.activeSubscriptionId && stripe?.resolvedPlan) return true;
  // Self-hosted: an enterprise license (litefuse_ee_ prefix) counts as paid —
  // mirrors resolveSelfHostedPlan in web/src/features/enterprise/plan/resolvePlan.ts.
  const license = process.env.LITEFUSE_EE_LICENSE_KEY;
  return Boolean(license?.startsWith("litefuse_ee_"));
};

/**
 * Designate a newly-created project for table split and kick provisioning.
 * Table split is UNIVERSAL — every project gets its own spans_<pid> /
 * traces_scalar_<pid> tables, independent of billing (retention TTL stays
 * paid-differentiated, derived at provisioning by getSplitRetentionDays).
 * Idempotent (upsert omits `split`, CREATE IF NOT EXISTS, per-project queue
 * de-dups).
 */
export const provisionSplitForNewProject = async (
  projectId: string,
): Promise<void> => {
  await upsertDorisProjectTableSplit({ projectId });
};

/**
 * All-split ingestion guard for existing/legacy projects. If a project has no
 * split control row yet, create a PENDING designation and enqueue provisioning.
 * Existing rows are left untouched so this can run on every ingestion request.
 */
export const ensureProjectSplitDesignated = async (
  projectId: string,
): Promise<void> => {
  const existing = await prisma.dorisProjectTableSplit.findUnique({
    where: { projectId },
    select: { projectId: true },
  });
  if (existing) return;

  try {
    await prisma.dorisProjectTableSplit.create({
      data: {
        projectId,
        split: false,
        note: "auto-designated by all-split ingestion",
      },
    });
  } catch (e) {
    const rowAfterRace = await prisma.dorisProjectTableSplit.findUnique({
      where: { projectId },
      select: { projectId: true },
    });
    if (rowAfterRace) return;
    throw e;
  }

  logger.info(
    `[table-split] auto-designated ${projectId}; enqueuing provisioning`,
  );
  try {
    await publishSplitCacheInvalidation();
  } catch (e) {
    logger.error(`[table-split] cache invalidation for ${projectId} failed`, e);
  }
  try {
    await enqueueDorisSplitTableProvisioning(projectId);
  } catch (e) {
    logger.error(
      `[table-split] provisioning enqueue for ${projectId} failed`,
      e,
    );
  }
};

/**
 * Write-path "table doesn't exist" three-way decision (Stage 1.2d). When a load
 * targets a split project's spans_<pid> / traces_scalar_<pid> that is
 * absent, the caller (the group-job load path, Stage 1.6) must NOT guess:
 *   - reprovision   : the project still exists → re-enqueue provisioning and
 *                     RETRY the job (tables will exist on the retry);
 *   - skip-tombstoned: the project is gone (deleted) → dead-letter/skip the
 *                     group; recreating its tables would resurrect dead data;
 *   - pg-error      : PG unreachable → cannot decide → RETRY (never guess).
 */
export type MissingSplitTableAction =
  | "reprovision"
  | "skip-tombstoned"
  | "pg-error";

export const classifyMissingSplitTable = async (
  projectId: string,
): Promise<MissingSplitTableAction> => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, deletedAt: true },
    });
    if (!project || project.deletedAt) return "skip-tombstoned";
    return "reprovision";
  } catch (e) {
    logger.error(
      `[table-split] classifyMissingSplitTable PG lookup failed for ${projectId}`,
      e,
    );
    return "pg-error";
  }
};

/**
 * Act on a missing split table and tell the caller whether to retry or skip.
 * "retry" ⇒ throw/fail the job so BullMQ re-runs it (tables provisioned by
 * then, or PG recovered); "skip" ⇒ the project is tombstoned, drop the group.
 */
export const handleMissingSplitTable = async (
  projectId: string,
): Promise<"retry" | "skip"> => {
  const action = await classifyMissingSplitTable(projectId);
  switch (action) {
    case "reprovision":
      await enqueueDorisSplitTableProvisioning(projectId);
      recordIncrement("langfuse.doris.split_table.missing", 1, {
        action: "reprovision",
      });
      logger.warn(
        `[table-split] missing tables for live project ${projectId}; re-enqueued provisioning, retrying job`,
      );
      return "retry";
    case "pg-error":
      recordIncrement("langfuse.doris.split_table.missing", 1, {
        action: "pg_error",
      });
      return "retry";
    case "skip-tombstoned":
      recordIncrement("langfuse.doris.split_table.missing", 1, {
        action: "skip_tombstoned",
      });
      logger.warn(
        `[table-split] missing tables for tombstoned project ${projectId}; skipping group`,
      );
      return "skip";
  }
};
