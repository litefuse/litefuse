import { auditLog } from "@/src/features/audit-logs/auditLog";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { env } from "@/src/env.mjs";
import {
  BaseError,
  BatchExportStatus,
  CreateBatchExportSchema,
  isBatchExportDownloadReadyStatus,
  paginationZod,
} from "@langfuse/shared";
import { logger } from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import {
  createBatchExportDownloadPath,
  createBatchExportDownloadToken,
} from "./batchExportDownloadToken";
import { estimateBatchExportSize } from "./exportService";

const CreateBatchExportResultSchema = z.object({
  batchExportId: z.string(),
  downloadPath: z.string(),
  estimatedFileSizeBytes: z.number().nonnegative(),
  mode: z.enum(["browser_download", "api_only"]),
});

export const batchExportRouter = createTRPCRouter({
  create: protectedProjectProcedure
    .input(CreateBatchExportSchema)
    .output(CreateBatchExportResultSchema)
    .mutation(async ({ input, ctx }) => {
      let exportJobId: string | null = null;

      try {
        // Check permissions, esp. projectId
        throwIfNoProjectAccess({
          session: ctx.session,
          projectId: input.projectId,
          scope: "batchExports:create",
        });

        const { projectId, query, format, name } = input;
        logger.info("[TRPC] Creating export job", { job: input });
        const userId = ctx.session.user.id;

        // Create export job
        const exportJob = await ctx.prisma.batchExport.create({
          data: {
            projectId,
            userId,
            status: BatchExportStatus.PROCESSING,
            name,
            format,
            query,
          },
        });
        exportJobId = exportJob.id;

        // Create audit log
        await auditLog({
          session: ctx.session,
          resourceType: "batchExport",
          resourceId: exportJob.id,
          projectId,
          action: "create",
          after: exportJob,
        });

        const estimate = await estimateBatchExportSize({
          projectId,
          query,
          format,
          cutoffCreatedAt: exportJob.createdAt,
        });

        const expiresAt = new Date(
          Date.now() +
            env.BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS * 60 * 60 * 1000,
        );
        const mode = estimate.exceedsBrowserDownloadLimit
          ? "api_only"
          : "browser_download";
        const status =
          mode === "browser_download"
            ? BatchExportStatus.READY
            : BatchExportStatus.READY_API;
        const estimatedSizeMb = (
          estimate.estimatedFileSizeBytes /
          (1024 * 1024)
        ).toFixed(2);

        await ctx.prisma.batchExport.update({
          where: {
            id: exportJob.id,
          },
          data: {
            status,
            expiresAt,
            log:
              mode === "browser_download"
                ? `Sample-based estimated export size: ${estimatedSizeMb} MB`
                : `Sample-based estimated export size exceeds 1 GB (${estimatedSizeMb} MB). Use the download API instead of the browser.`,
          },
        });

        const downloadToken = createBatchExportDownloadToken({
          batchExportId: exportJob.id,
          projectId,
          expiresAt: expiresAt.toISOString(),
        });

        return {
          batchExportId: exportJob.id,
          downloadPath: createBatchExportDownloadPath(projectId, downloadToken),
          estimatedFileSizeBytes: estimate.estimatedFileSizeBytes,
          mode,
        };
      } catch (e) {
        logger.error(e);

        if (exportJobId) {
          await ctx.prisma.batchExport
            .update({
              where: {
                id: exportJobId,
              },
              data: {
                status: BatchExportStatus.FAILED,
                finishedAt: new Date(),
                log:
                  e instanceof BaseError || e instanceof Error
                    ? e.message
                    : "Creating export job failed.",
              },
            })
            .catch(() => undefined);
        }

        if (e instanceof TRPCError) {
          throw e;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Creating export job failed.",
        });
      }
    }),
  cancel: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        batchExportId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "batchExports:create",
      });

      const { count } = await ctx.prisma.batchExport.updateMany({
        where: { id: input.batchExportId, projectId: input.projectId },
        data: { status: BatchExportStatus.CANCELLED },
      });

      if (count === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Batch export not found.",
        });
      }
    }),
  all: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        ...paginationZod,
      }),
    )
    .query(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "batchExports:read",
      });

      const [exports, totalCount] = await Promise.all([
        ctx.prisma.batchExport.findMany({
          where: {
            projectId: input.projectId,
          },
          take: input.limit,
          skip: input.page * input.limit,
          orderBy: {
            createdAt: "desc",
          },
        }),
        ctx.prisma.batchExport.count({
          where: {
            projectId: input.projectId,
          },
        }),
      ]);

      // Look up users for each export
      const userIds = [...new Set(exports.map((e) => e.userId))];
      const users = await ctx.prisma.user.findMany({
        where: {
          id: {
            in: userIds,
          },
          organizationMemberships: {
            some: {
              organization: {
                projects: {
                  some: {
                    id: input.projectId,
                  },
                },
              },
            },
          },
        },
        select: {
          id: true,
          name: true,
          image: true,
        },
      });

      const userMap = new Map(users.map((u) => [u.id, u]));

      const exportsWithExpiration = exports.map((e) => {
        const { finishedAt, url, ...rest } = e;

        let isExpired = false;
        const now = new Date().getTime();
        if (e.expiresAt) {
          isExpired = new Date(e.expiresAt).getTime() <= now;
        } else if (finishedAt) {
          const finishTime = new Date(finishedAt).getTime();
          const oneHourInMs = 60 * 60 * 1000;
          isExpired = now - finishTime > oneHourInMs;
        }

        let effectiveUrl = url;
        if (
          !effectiveUrl &&
          !isExpired &&
          isBatchExportDownloadReadyStatus(e.status)
        ) {
          const expiresAt =
            e.expiresAt ??
            (finishedAt
              ? new Date(finishedAt.getTime() + 60 * 60 * 1000)
              : new Date(
                  Date.now() +
                    env.BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS *
                      60 *
                      60 *
                      1000,
                ));
          const downloadToken = createBatchExportDownloadToken({
            batchExportId: e.id,
            projectId: e.projectId,
            expiresAt: expiresAt.toISOString(),
          });
          effectiveUrl = createBatchExportDownloadPath(
            e.projectId,
            downloadToken,
          );
        }

        return {
          ...rest,
          finishedAt,
          url: isExpired ? "expired" : effectiveUrl,
          user: userMap.get(e.userId) ?? null,
        };
      });

      return {
        exports: exportsWithExpiration,
        totalCount,
      };
    }),
});
