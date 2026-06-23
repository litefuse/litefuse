import { z } from "zod/v4";
import {
  BlobStorageIntegrationType,
  BlobStorageIntegrationFileType,
  BlobStorageExportMode,
  AnalyticsIntegrationExportSource,
  OBSERVATION_FIELD_GROUPS,
  DEFAULT_OBSERVATION_FIELD_GROUPS,
} from "@langfuse/shared";
import { validateBlobStorageIntegrationConfig } from "@/src/features/blobstorage-integration/validation";

export const blobStorageIntegrationFormSchemaBase = z.object({
  type: z.enum(BlobStorageIntegrationType),
  bucketName: z.string().min(1, { message: "Bucket name is required" }),
  endpoint: z.string().url().optional().nullable(),
  region: z.string().default("auto"),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().nullable().optional(),
  prefix: z
    .string()
    .refine((value) => !value || value === "" || value.endsWith("/"), {
      message: "Prefix must end with a forward slash (/)",
    })
    .optional()
    .or(z.literal("")),
  exportFrequency: z.enum(["hourly", "daily", "weekly"]),
  enabled: z.boolean(),
  forcePathStyle: z.boolean(),
  fileType: z
    .enum(BlobStorageIntegrationFileType)
    .default(BlobStorageIntegrationFileType.JSONL),
  exportMode: z
    .enum(BlobStorageExportMode)
    .default(BlobStorageExportMode.FULL_HISTORY),
  exportStartDate: z.coerce.date().optional().nullable(),
  exportSource: z
    .enum(AnalyticsIntegrationExportSource)
    .default(AnalyticsIntegrationExportSource.TRACES_OBSERVATIONS),
  exportFieldGroups: z
    .array(z.enum(OBSERVATION_FIELD_GROUPS))
    .default(DEFAULT_OBSERVATION_FIELD_GROUPS),
  compressed: z.boolean().default(true),
});

export const blobStorageIntegrationFormSchema =
  blobStorageIntegrationFormSchemaBase.superRefine((data, ctx) => {
    if (data.exportMode === "FROM_CUSTOM_DATE" && !data.exportStartDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Export start date is required for custom date exports",
        path: ["exportStartDate"],
      });
    }
    validateBlobStorageIntegrationConfig(data, ctx);
  });

export type BlobStorageIntegrationFormSchema = z.infer<
  typeof blobStorageIntegrationFormSchema
>;

export type BlobStorageSyncStatus =
  | "idle"
  | "queued"
  | "up_to_date"
  | "disabled"
  | "error";
