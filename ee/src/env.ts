import { z } from "zod/v4";
import { removeEmptyEnvVariables } from "@langfuse/shared";

const EnvSchema = z.object({
  NEXT_PUBLIC_LITEFUSE_CLOUD_REGION: z.string().optional(),
  LITEFUSE_EE_LICENSE_KEY: z.string().optional(),
});

export const env = EnvSchema.parse(removeEmptyEnvVariables(process.env));
