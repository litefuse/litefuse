import { randomUUID } from "crypto";

import { env } from "@/src/env.mjs";
import { getFileExtensionFromContentType } from "@/src/features/media/server/getFileExtensionFromContentType";
import { getMediaStorageServiceClient } from "@/src/features/media/server/getMediaStorageClient";
import {
  GetMediaUploadUrlQuerySchema,
  GetMediaUploadUrlResponseSchema,
  type MediaContentType,
} from "@/src/features/media/validation";
import { createAuthedProjectAPIRoute } from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import {
  BaseError,
  ForbiddenError,
  InternalServerError,
  InvalidRequestError,
  NotImplementedError,
} from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import { logger, instrumentAsync } from "@langfuse/shared/src/server";

export default withMiddlewares({
  POST: createAuthedProjectAPIRoute({
    name: "Get Media Upload URL",
    bodySchema: GetMediaUploadUrlQuerySchema,
    responseSchema: GetMediaUploadUrlResponseSchema,
    successStatusCode: 201,
    rateLimitResource: "ingestion",
    fn: async ({ body, auth }) => {
      if (auth.scope.accessLevel !== "project") throw new ForbiddenError();

      const { projectId } = auth.scope;
      const {
        contentType,
        contentLength,
        sha256Hash,
        traceId,
        observationId,
        field,
      } = body;

      if (contentLength > env.LITEFUSE_S3_MEDIA_MAX_CONTENT_LENGTH)
        throw new InvalidRequestError(
          `File size must be less than ${env.LITEFUSE_S3_MEDIA_MAX_CONTENT_LENGTH} bytes`,
        );

      // Fail fast with an unambiguous 501 when media upload isn't
      // configured on this deployment. The previous in-block check was
      // shadowed by the catch-all below, so operators only saw the
      // generic "Failed to get media upload URL" and had no way to
      // realise the cause was a missing env var.
      const mediaBucket = env.LITEFUSE_S3_MEDIA_UPLOAD_BUCKET;
      if (!mediaBucket) {
        throw new NotImplementedError(
          "Media upload is not enabled on this deployment: LITEFUSE_S3_MEDIA_UPLOAD_BUCKET is unset. Configure the LITEFUSE_S3_MEDIA_UPLOAD_* env vars (bucket, region, endpoint, credentials) and restart the web container.",
        );
      }

      return await instrumentAsync(
        { name: "media-create-upload-url" },
        async (span) => {
          span.setAttribute("projectId", projectId);
          span.setAttribute("traceId", traceId);
          span.setAttribute("observationId", observationId ?? "");
          span.setAttribute("field", field);
          span.setAttribute("sha256Hash", sha256Hash);

          try {
            const existingMedia = await prisma.media.findUnique({
              where: {
                projectId_sha256Hash: {
                  projectId,
                  sha256Hash,
                },
              },
            });

            if (
              existingMedia &&
              existingMedia.uploadHttpStatus === 200 &&
              existingMedia.contentType === contentType
            ) {
              span.setAttribute("mediaId", existingMedia.id);

              if (observationId) {
                // Use raw upserts to avoid deadlocks
                await prisma.$queryRaw`
              INSERT INTO "observation_media" ("id", "project_id", "trace_id", "observation_id", "media_id", "field")
              VALUES (${randomUUID()}, ${projectId}, ${traceId}, ${observationId}, ${existingMedia.id}, ${field})
              ON CONFLICT DO NOTHING;
            `;
              } else {
                // Use raw upserts to avoid deadlocks
                await prisma.$queryRaw`
              INSERT INTO "trace_media" ("id", "project_id", "trace_id", "media_id", "field")
              VALUES (${randomUUID()}, ${projectId}, ${traceId}, ${existingMedia.id}, ${field})
              ON CONFLICT DO NOTHING;
            `;
              }

              return {
                mediaId: existingMedia.id,
                uploadUrl: null,
              };
            }

            const mediaId = existingMedia?.id ?? getMediaId({ sha256Hash });

            span.setAttribute("mediaId", mediaId);

            const s3Client = getMediaStorageServiceClient(mediaBucket);

            const bucketPath = getBucketPath({
              projectId,
              mediaId,
              contentType,
            });

            const uploadUrl = await s3Client.getSignedUploadUrl({
              path: bucketPath,
              ttlSeconds: 60 * 60, // 1 hour
              sha256Hash,
              contentType,
              contentLength,
            });

            // Create media record first to ensure fkey constraint is met on next queries
            // Under high concurrency, the upsert might fail due to the multiple uniqueness constraints
            // (id and (project_id ad sha_256))
            // See also: https://stackoverflow.com/questions/73164161/insert-on-conflict-do-update-set-an-upsert-statement-with-a-unique-constraint
            const maxRetries = 3;
            const delayMs = 100;
            let retryCount = 0;

            while (retryCount < maxRetries) {
              try {
                await prisma.$queryRaw`
                  INSERT INTO "media" (
                      "id",
                      "project_id",
                      "sha_256_hash",
                      "bucket_path",
                      "bucket_name",
                      "content_type",
                      "content_length"
                    )
                    VALUES (
                      ${mediaId},
                      ${projectId},
                      ${sha256Hash},
                      ${bucketPath},
                      ${mediaBucket},
                      ${contentType},
                      ${contentLength}
                    )
                    ON CONFLICT ("project_id", "sha_256_hash")
                    DO UPDATE SET
                      "bucket_name" = ${mediaBucket},
                      "bucket_path" = ${bucketPath},
                      "content_type" = ${contentType},
                      "content_length" = ${contentLength}
                  `;
                break;
              } catch (e) {
                retryCount += 1;

                if (retryCount >= maxRetries) throw e;

                logger.debug(
                  `Failed to create media record. Retrying (${retryCount}/${maxRetries})...`,
                );

                await new Promise((resolve) => setTimeout(resolve, delayMs));
              }
            }

            if (observationId) {
              await prisma.$queryRaw`
                INSERT INTO "observation_media" ("id", "project_id", "trace_id", "observation_id", "media_id", "field")
                VALUES (${randomUUID()}, ${projectId}, ${traceId}, ${observationId}, ${mediaId}, ${field})
                ON CONFLICT DO NOTHING;
            `;
            } else {
              await prisma.$queryRaw`
                INSERT INTO "trace_media" ("id", "project_id", "trace_id", "media_id", "field")
                VALUES (${randomUUID()}, ${projectId}, ${traceId}, ${mediaId}, ${field})
                ON CONFLICT DO NOTHING;
            `;
            }

            return {
              mediaId,
              uploadUrl,
            };
          } catch (error) {
            // Operational errors carry an explicit HTTP status + message
            // (e.g. NotImplementedError for missing config,
            // InvalidRequestError for bad payload, LangfuseNotFoundError
            // for missing trace). Re-throw those untouched so the client
            // gets the right status code instead of a flat 500.
            if (error instanceof BaseError) {
              throw error;
            }
            // Unknown failure (DB, S3 SDK, network). Log the full error
            // with stack so operators can diagnose, then surface the
            // root-cause message in the 500 response — previously the
            // bare `catch {}` discarded the error entirely and operators
            // only saw the wrapper message.
            const cause =
              error instanceof Error ? error.message : String(error);
            logger.error(
              `Failed to get media upload URL for trace ${traceId} and observation ${observationId}: ${cause}`,
              error,
            );
            throw new InternalServerError(
              `Failed to get media upload URL: ${cause}`,
            );
          }
        },
      );
    },
  }),
});

function getBucketPath(params: {
  projectId: string;
  mediaId: string;
  contentType: MediaContentType;
}): string {
  const { projectId, mediaId, contentType } = params;
  const fileExtension = getFileExtensionFromContentType(contentType);

  const prefix = env.LITEFUSE_S3_MEDIA_UPLOAD_PREFIX
    ? `${env.LITEFUSE_S3_MEDIA_UPLOAD_PREFIX}`
    : "";

  return `${prefix}${projectId}/${mediaId}.${fileExtension}`;
}

function getMediaId(params: { sha256Hash: string }) {
  const { sha256Hash } = params;

  // Make hash URL safe
  const urlSafeHash = sha256Hash.replaceAll("+", "-").replaceAll("/", "_");

  // Get first 132 bits, i.e. first 22 base64Url chars
  return urlSafeHash.slice(0, 22);
}
