import { type PrismaClient } from "@langfuse/shared/src/db";
import {
  BlobStorageExportMode,
  BlobStorageIntegrationType,
  DEFAULT_OBSERVATION_FIELD_GROUPS,
  InvalidRequestError,
  type AnalyticsIntegrationExportSource,
  type BlobStorageIntegrationFileType,
  type ObservationFieldGroup,
} from "@langfuse/shared";
import { encrypt } from "@langfuse/shared/encryption";
import { env } from "@/src/env.mjs";

type UpsertBlobStorageIntegrationInput = {
  type: BlobStorageIntegrationType;
  bucketName: string;
  endpoint: string | null;
  region: string;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  prefix: string;
  exportFrequency: string;
  enabled: boolean;
  forcePathStyle: boolean;
  fileType: BlobStorageIntegrationFileType;
  exportMode: BlobStorageExportMode;
  exportStartDate: Date | null;
  exportSource: AnalyticsIntegrationExportSource;
  exportFieldGroups: ObservationFieldGroup[];
  compressed: boolean;
};

function resolveExportStartDate({
  exportMode,
  exportStartDate,
}: Pick<UpsertBlobStorageIntegrationInput, "exportMode" | "exportStartDate">) {
  if (exportMode === BlobStorageExportMode.FROM_TODAY) return new Date();
  if (exportMode === BlobStorageExportMode.FROM_CUSTOM_DATE)
    return exportStartDate || new Date();
  return null;
}

export async function upsertBlobStorageIntegration({
  prisma,
  projectId,
  data,
}: {
  prisma: PrismaClient;
  projectId: string;
  data: UpsertBlobStorageIntegrationInput;
}) {
  const accessKeyId = data.accessKeyId || null;
  const secretAccessKey = data.secretAccessKey || null;
  const isSelfHosted = !env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION;
  const canUseHostCredentials =
    isSelfHosted && data.type === BlobStorageIntegrationType.S3;
  if (!canUseHostCredentials && !accessKeyId) {
    throw new InvalidRequestError(
      "Access Key ID and Secret Access Key are required",
    );
  }

  const writeData = {
    type: data.type,
    bucketName: data.bucketName,
    endpoint:
      data.type === BlobStorageIntegrationType.S3
        ? null
        : data.endpoint || null,
    region: data.region,
    accessKeyId,
    prefix: data.prefix,
    exportFrequency: data.exportFrequency,
    enabled: data.enabled,
    forcePathStyle: data.forcePathStyle,
    fileType: data.fileType,
    exportMode: data.exportMode,
    exportStartDate: resolveExportStartDate(data),
    exportSource: data.exportSource,
    exportFieldGroups: data.exportFieldGroups.length
      ? data.exportFieldGroups
      : DEFAULT_OBSERVATION_FIELD_GROUPS,
    compressed: data.compressed,
  };

  return prisma.$transaction(async (tx) => {
    const existing = await tx.blobStorageIntegration.findUnique({
      where: { projectId },
      select: { exportMode: true },
    });
    const usesHostCredentials =
      canUseHostCredentials && (!accessKeyId || !secretAccessKey);
    if (!existing && !usesHostCredentials && !secretAccessKey) {
      throw new InvalidRequestError(
        "Secret access key is required for new configuration",
      );
    }
    const encryptedSecret = secretAccessKey ? encrypt(secretAccessKey) : null;
    return tx.blobStorageIntegration.upsert({
      where: { projectId },
      create: { ...writeData, projectId, secretAccessKey: encryptedSecret },
      update: {
        ...writeData,
        ...(encryptedSecret ? { secretAccessKey: encryptedSecret } : {}),
        ...(existing?.exportMode !== data.exportMode
          ? { lastSyncAt: null, nextSyncAt: null }
          : {}),
      },
    });
  });
}
