import { env } from "@/src/env.mjs";
import {
  type StorageService,
  StorageServiceFactory,
} from "@langfuse/shared/src/server";

let s3StorageServiceClient: StorageService;

export const getMediaStorageServiceClient = (
  bucketName: string,
): StorageService => {
  if (!s3StorageServiceClient) {
    s3StorageServiceClient = StorageServiceFactory.getInstance({
      bucketName,
      accessKeyId: env.LITEFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LITEFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY,
      endpoint: env.LITEFUSE_S3_MEDIA_UPLOAD_ENDPOINT,
      region: env.LITEFUSE_S3_MEDIA_UPLOAD_REGION,
      forcePathStyle: env.LITEFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE === "true",
      awsSse: env.LITEFUSE_S3_MEDIA_UPLOAD_SSE,
      awsSseKmsKeyId: env.LITEFUSE_S3_MEDIA_UPLOAD_SSE_KMS_KEY_ID,
    });
  }
  return s3StorageServiceClient;
};
