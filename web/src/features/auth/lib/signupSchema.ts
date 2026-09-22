import { noUrlCheck, StringNoHTMLNonEmpty } from "@langfuse/shared";
import * as z from "zod/v4";

import { i18nKey } from "@/src/features/i18n/i18nKey";
export const passwordSchema = z
  .string()
  .min(8, { message: i18nKey("Password must be at least 8 characters long.") })
  .regex(/[A-Za-z]/, {
    message: i18nKey(
      "Please choose a secure password by combining letters, numbers, and special characters.",
    ),
  })
  .regex(/[0-9]/, {
    message: i18nKey(
      "Please choose a secure password by combining letters, numbers, and special characters.",
    ),
  })
  .regex(/[^A-Za-z0-9]/, {
    message: i18nKey(
      "Please choose a secure password by combining letters, numbers, and special characters.",
    ),
  });

export const signupSchema = z.object({
  name: StringNoHTMLNonEmpty.refine((value) => noUrlCheck(value), {
    message: i18nKey("Input should not contain a URL"),
  }).refine((value) => /^[a-zA-Z0-9\s]+$/.test(value), {
    message: i18nKey("Name can only contain letters, numbers, and spaces"),
  }),
  email: z.string().email(),
  password: passwordSchema,
  referralSource: z.string().optional(),
});
