import { type PrismaClient } from "@langfuse/shared/src/db";
import {
  BlobStorageExportMode,
  BlobStorageIntegrationType,
  InvalidRequestError,
  type BlobStorageIntegrationFileType,
  type AnalyticsIntegrationExportSource,
  type ObservationFieldGroup,
  DEFAULT_OBSERVATION_FIELD_GROUPS,
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

function resolveExportStartDate(params: {
  exportMode: BlobStorageExportMode;
  exportStartDate: Date | null;
}): Date | null {
  switch (params.exportMode) {
    case BlobStorageExportMode.FROM_TODAY:
      return new Date();
    case BlobStorageExportMode.FROM_CUSTOM_DATE:
      return params.exportStartDate || new Date();
    case BlobStorageExportMode.FULL_HISTORY:
      return null;
    default: {
      const _exhaustive: never = params.exportMode;
      void _exhaustive;
      return null;
    }
  }
}

export async function upsertBlobStorageIntegration(params: {
  prisma: PrismaClient;
  projectId: string;
  data: UpsertBlobStorageIntegrationInput;
}) {
  const { prisma, projectId, data } = params;

  const normalizedAccessKeyId = data.accessKeyId || null;
  const normalizedSecretAccessKey = data.secretAccessKey || null;
  const normalizedEndpoint =
    data.type === BlobStorageIntegrationType.S3 ? null : data.endpoint || null;

  const isSelfHosted = !env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION;
  const canUseHostCredentials =
    isSelfHosted && data.type === BlobStorageIntegrationType.S3;

  if (!canUseHostCredentials && !normalizedAccessKeyId) {
    throw new InvalidRequestError(
      "Access Key ID and Secret Access Key are required",
    );
  }

  const resolvedExportStartDate = resolveExportStartDate({
    exportMode: data.exportMode,
    exportStartDate: data.exportStartDate,
  });

  const writeData = {
    type: data.type,
    bucketName: data.bucketName,
    endpoint: normalizedEndpoint,
    region: data.region,
    accessKeyId: normalizedAccessKeyId,
    prefix: data.prefix,
    exportFrequency: data.exportFrequency,
    enabled: data.enabled,
    forcePathStyle: data.forcePathStyle,
    fileType: data.fileType,
    exportMode: data.exportMode,
    exportStartDate: resolvedExportStartDate,
    exportSource: data.exportSource,
    exportFieldGroups:
      data.exportFieldGroups.length > 0
        ? data.exportFieldGroups
        : DEFAULT_OBSERVATION_FIELD_GROUPS,
    compressed: data.compressed,
  };

  return prisma.$transaction(async (tx) => {
    const existing = await tx.blobStorageIntegration.findUnique({
      where: { projectId },
      select: { exportMode: true },
    });

    if (!existing) {
      const isUsingHostCredentials =
        canUseHostCredentials &&
        (!normalizedAccessKeyId || !normalizedSecretAccessKey);

      if (!isUsingHostCredentials && !normalizedSecretAccessKey) {
        throw new InvalidRequestError(
          "Secret access key is required for new configuration",
        );
      }
    }

    const modeChanged = existing?.exportMode !== data.exportMode;
    const encryptedSecret = normalizedSecretAccessKey
      ? encrypt(normalizedSecretAccessKey)
      : null;

    return tx.blobStorageIntegration.upsert({
      where: { projectId },
      create: {
        ...writeData,
        projectId,
        secretAccessKey: encryptedSecret,
      },
      update: {
        ...writeData,
        ...(encryptedSecret ? { secretAccessKey: encryptedSecret } : {}),
        ...(modeChanged ? { lastSyncAt: null, nextSyncAt: null } : {}),
      },
    });
  });
}
