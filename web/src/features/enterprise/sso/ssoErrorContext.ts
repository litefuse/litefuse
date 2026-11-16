import { z } from "zod/v4";

/** Diagnostics must not include input values, exception messages, URLs or tokens. */
export function ssoErrorContext(error: unknown): Record<string, unknown> {
  if (error instanceof z.ZodError) {
    return {
      reason: "invalid_configuration",
      issues: error.issues.map(({ path, code }) => ({ path, code })),
    };
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^P\d{4}$/.test(error.code)
  ) {
    return { reason: "database_error", code: error.code };
  }
  return { reason: "internal_error" };
}
