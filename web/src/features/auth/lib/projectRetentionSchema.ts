import * as z from "zod/v4";
import { RETENTION_FLOOR_DAYS } from "@langfuse/shared";

export const projectRetentionSchema = z.object({
  retention: z.coerce
    .number()
    .int("Must be an integer")
    .refine((value) => value === 0 || value >= RETENTION_FLOOR_DAYS, {
      message: `Value must be 0 or at least ${RETENTION_FLOOR_DAYS} days`,
    }),
});
