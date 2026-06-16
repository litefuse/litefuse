import { env } from "../../env";
import {
  StorageService,
  StorageServiceFactory,
} from "../services/StorageService";

// Event-upload S3 client removed: ingestion no longer stages event
// JSONs in MinIO. Only the media upload bucket survives (multimodal
// attachments still need an object store).

let s3MediaStorageClient: StorageService;

export const getS3MediaStorageClient = (bucketName: string): StorageService => {
  if (!s3MediaStorageClient) {
    s3MediaStorageClient = StorageServiceFactory.getInstance({
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
  return s3MediaStorageClient;
};
