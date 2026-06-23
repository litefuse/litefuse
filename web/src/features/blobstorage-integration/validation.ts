import {
  type ObservationFieldGroup,
  OBSERVATION_FIELD_GROUPS,
} from "@langfuse/shared";
import { z } from "zod/v4";

/**
 * Azure container names must be 3-63 characters, lowercase letters, numbers,
 * and hyphens only. Must start and end with a letter or number. No consecutive
 * hyphens.
 *
 * @see https://learn.microsoft.com/en-us/rest/api/storageservices/naming-and-referencing-containers--blobs--and-metadata#container-names
 */
export const AZURE_CONTAINER_NAME_REGEX =
  /^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/;

export const AZURE_CONTAINER_NAME_ERROR =
  "Azure container names must be 3-63 characters, lowercase letters, numbers, and hyphens only. Must start and end with a letter or number, no consecutive hyphens.";

export function validateAzureContainerName(
  data: { type: string; bucketName: string },
  ctx: z.RefinementCtx,
) {
  if (!data.bucketName) return;
  if (
    data.type === "AZURE_BLOB_STORAGE" &&
    !AZURE_CONTAINER_NAME_REGEX.test(data.bucketName)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: AZURE_CONTAINER_NAME_ERROR,
      path: ["bucketName"],
    });
  }
}

export function validateBlobStorageExportFieldGroups(
  exportFieldGroups: ObservationFieldGroup[] | undefined,
  ctx: z.RefinementCtx,
) {
  if (!exportFieldGroups?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one export field group must be selected",
      path: ["exportFieldGroups"],
    });
    return;
  }

  if (!exportFieldGroups.includes("core")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The core export field group is required",
      path: ["exportFieldGroups"],
    });
  }

  const invalidGroups = exportFieldGroups.filter(
    (group) => !OBSERVATION_FIELD_GROUPS.includes(group),
  );
  if (invalidGroups.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid export field group selection: ${invalidGroups.join(", ")}`,
      path: ["exportFieldGroups"],
    });
  }
}

export function validateBlobStorageIntegrationConfig(
  data: {
    type: string;
    bucketName: string;
    exportFieldGroups?: ObservationFieldGroup[];
  },
  ctx: z.RefinementCtx,
) {
  validateAzureContainerName(data, ctx);
  validateBlobStorageExportFieldGroups(data.exportFieldGroups, ctx);
}
