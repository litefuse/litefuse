import {
  createTRPCRouter,
  protectedOrganizationProcedure,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import * as z from "zod/v4";
import { RETENTION_FLOOR_DAYS } from "@langfuse/shared";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { TRPCError } from "@trpc/server";
import { projectNameSchema } from "@/src/features/auth/lib/projectNameSchema";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { throwIfNoOrganizationAccess } from "@/src/features/rbac/utils/checkOrganizationAccess";
import { throwIfExceedsLimit } from "@/src/features/entitlements/server/hasEntitlementLimit";
import { throwIfNoEntitlement } from "@/src/features/entitlements/server/hasEntitlement";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import {
  QueueJobs,
  redis,
  ProjectDeleteQueue,
  getEnvironmentsForProject,
  provisionSplitForNewProject,
  enqueueDorisSplitTableProvisioning,
  logger,
} from "@langfuse/shared/src/server";
import { randomUUID } from "crypto";
import {
  getDefaultScoreConfigsForProject,
  StringNoHTMLNonEmpty,
} from "@langfuse/shared";
import { seedProjectAnnotationDefaults } from "@/src/features/projects/server/seedProjectAnnotationDefaults";

export const projectsRouter = createTRPCRouter({
  create: protectedOrganizationProcedure
    .input(
      z.object({
        name: StringNoHTMLNonEmpty,
        orgId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoOrganizationAccess({
        session: ctx.session,
        organizationId: input.orgId,
        scope: "projects:create",
      });

      const project = await ctx.prisma.$transaction(async (tx) => {
        // Serialize project creation for an organization so concurrent requests
        // cannot both pass the entitlement count before either creates a project.
        await tx.$queryRaw`
          SELECT id FROM organizations WHERE id = ${input.orgId} FOR UPDATE
        `;

        const existingProject = await tx.project.findFirst({
          where: {
            name: input.name,
            orgId: input.orgId,
            deletedAt: null,
          },
        });

        if (existingProject) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "A project with this name already exists in your organization",
          });
        }

        const activeProjectCount = await tx.project.count({
          where: {
            orgId: input.orgId,
            deletedAt: null,
          },
        });

        throwIfExceedsLimit({
          entitlementLimit: "project-count",
          sessionUser: ctx.session.user,
          orgId: input.orgId,
          currentUsage: activeProjectCount,
          message: "Free plan allows up to 3 projects per organization",
        });

        const newProject = await tx.project.create({
          data: {
            name: input.name,
            orgId: input.orgId,
          },
        });

        // Seed built-in defaults for the new project (Postgres-only), inside
        // the same creation transaction: the standard managed score configs,
        // plus the Correctness annotation queue + its score config.
        await tx.scoreConfig.createMany({
          data: getDefaultScoreConfigsForProject(newProject.id),
        });
        await seedProjectAnnotationDefaults(tx, newProject.id);

        return newProject;
      });

      // Universal Doris table split: EVERY new project gets its own tables
      // (billing-independent; retention TTL stays paid-differentiated, derived
      // at provisioning). The client gets the project id only after this
      // returns, so designating it BEFORE then guarantees its first rows wait
      // on the project lane while tables are provisioned. RELIABLE +
      // compensating: if designation fails
      // (a rare PG blip on the control-row write), delete the just-created
      // project so the mutation fails cleanly instead of leaving an undesignated
      // project. The provisioning
      // enqueue/propagation inside upsert are best-effort.
      try {
        await provisionSplitForNewProject(project.id);
      } catch (e) {
        await ctx.prisma.project
          .delete({ where: { id: project.id } })
          .catch(() => undefined);
        throw e;
      }

      await auditLog({
        session: ctx.session,
        resourceType: "project",
        resourceId: project.id,
        action: "create",
        after: project,
      });

      return {
        id: project.id,
        name: project.name,
        role: "OWNER",
      };
    }),

  update: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        newName: projectNameSchema.shape.name,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "project:update",
      });

      // check if the project name is already taken by another project
      const otherProjectWithSameName = await ctx.prisma.project.findFirst({
        where: {
          name: input.newName,
          orgId: ctx.session.orgId,
          deletedAt: null,
          id: {
            not: input.projectId,
          },
        },
      });
      if (otherProjectWithSameName) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "A project with this name already exists in your organization",
        });
      }

      const project = await ctx.prisma.project.update({
        where: {
          id: input.projectId,
          orgId: ctx.session.orgId,
        },
        data: {
          name: input.newName,
        },
      });
      await auditLog({
        session: ctx.session,
        resourceType: "project",
        resourceId: input.projectId,
        action: "update",
        after: project,
      });
      return true;
    }),

  setRetention: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        retention: z.number().int().gte(RETENTION_FLOOR_DAYS).nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "project:update",
      });
      if (input.retention !== null && input.retention > 0) {
        throwIfNoEntitlement({
          entitlement: "data-retention",
          sessionUser: ctx.session.user,
          projectId: input.projectId,
        });
      }

      const project = await ctx.prisma.project.update({
        where: {
          id: input.projectId,
          orgId: ctx.session.orgId,
        },
        data: {
          retentionDays: input.retention,
        },
      });
      await auditLog({
        session: ctx.session,
        resourceType: "project",
        resourceId: input.projectId,
        action: "update",
        after: project,
      });

      // Retention is single-sourced on Project.retentionDays. If this project is
      // split, its dynamic_partition TTL must follow — re-enqueue provisioning,
      // which idempotently ALTERs the split tables' TTL to the new value (and
      // no-ops until the control row exists). Best-effort — never fail the setting.
      await enqueueDorisSplitTableProvisioning(input.projectId).catch((e) =>
        logger.error(
          `[table-split] TTL re-provision enqueue for ${input.projectId} failed`,
          e,
        ),
      );
      return true;
    }),

  delete: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: ctx.session.projectId,
        scope: "project:delete",
      });

      // API keys need to be deleted from cache. Otherwise, they will still be valid.
      await new ApiAuthService(
        ctx.prisma,
        redis,
      ).invalidateCachedProjectApiKeys(input.projectId);

      // Delete API keys from DB
      await ctx.prisma.apiKey.deleteMany({
        where: {
          projectId: input.projectId,
          scope: "PROJECT",
        },
      });

      const project = await ctx.prisma.project.update({
        where: {
          id: input.projectId,
          orgId: ctx.session.orgId,
        },
        data: {
          deletedAt: new Date(),
        },
      });

      await auditLog({
        session: ctx.session,
        resourceType: "project",
        resourceId: input.projectId,
        before: project,
        action: "delete",
      });

      const projectDeleteQueue = ProjectDeleteQueue.getInstance();
      if (!projectDeleteQueue) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "ProjectDeleteQueue is not available. Please try again later.",
        });
      }

      await projectDeleteQueue.add(QueueJobs.ProjectDelete, {
        timestamp: new Date(),
        id: randomUUID(),
        payload: {
          projectId: input.projectId,
          orgId: ctx.session.orgId,
        },
        name: QueueJobs.ProjectDelete,
      });

      return true;
    }),

  transfer: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        targetOrgId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // source org
      throwIfNoOrganizationAccess({
        session: ctx.session,
        organizationId: ctx.session.orgId,
        scope: "projects:transfer_org",
      });
      // destination org
      throwIfNoOrganizationAccess({
        session: ctx.session,
        organizationId: input.targetOrgId,
        scope: "projects:transfer_org",
      });

      const project = await ctx.prisma.project.findUnique({
        where: {
          id: input.projectId,
          deletedAt: null,
        },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      await ctx.prisma.$transaction(async (tx) => {
        // Serialize transfers into an organization so concurrent transfers
        // cannot both pass the entitlement count before either is applied.
        await tx.$queryRaw`
          SELECT id FROM organizations WHERE id = ${input.targetOrgId} FOR UPDATE
        `;

        if (ctx.session.orgId !== input.targetOrgId) {
          const activeProjectCount = await tx.project.count({
            where: {
              orgId: input.targetOrgId,
              deletedAt: null,
            },
          });

          throwIfExceedsLimit({
            entitlementLimit: "project-count",
            sessionUser: ctx.session.user,
            orgId: input.targetOrgId,
            currentUsage: activeProjectCount,
            message: "Free plan allows up to 3 projects per organization",
          });
        }

        await tx.projectMembership.deleteMany({
          where: {
            projectId: input.projectId,
          },
        });
        await tx.project.update({
          where: {
            id: input.projectId,
            orgId: ctx.session.orgId,
          },
          data: {
            orgId: input.targetOrgId,
          },
        });
      });

      await auditLog({
        session: ctx.session,
        resourceType: "project",
        resourceId: input.projectId,
        action: "transfer",
        before: { orgId: ctx.session.orgId },
        after: { orgId: input.targetOrgId },
      });

      // API keys need to be deleted from cache. Otherwise, they will still be valid.
      // It has to be called after the db is done to prevent new API keys from being cached.
      await new ApiAuthService(
        ctx.prisma,
        redis,
      ).invalidateCachedProjectApiKeys(input.projectId);

      // Re-provision the Doris split tables: the project's effective retention
      // is derived from the (now different) org's paid status
      // (getSplitRetentionDays), so the split tables' dynamic_partition.start
      // must be re-applied — free→paid widens it (e.g. 30d → 3y), paid→free
      // narrows it back. Mirrors the plan-change re-provision in billingService.
      await enqueueDorisSplitTableProvisioning(input.projectId).catch(
        (error) => {
          // The transfer is already persisted; a transient queue failure must
          // not fail the mutation. The provisioning reconciler retries later.
          logger.error(
            `[table-split] failed to re-provision project ${input.projectId} after transfer`,
            error,
          );
        },
      );
    }),

  environmentFilterOptions: protectedProjectProcedure
    .input(
      z.object({ projectId: z.string(), fromTimestamp: z.date().optional() }),
    )
    .query(async ({ input }) => getEnvironmentsForProject(input)),
});
