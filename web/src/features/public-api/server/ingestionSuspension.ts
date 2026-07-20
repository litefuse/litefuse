import { ForbiddenError } from "@langfuse/shared";

export function throwIfIngestionSuspended(scope: {
  isIngestionSuspended?: boolean | null;
}) {
  if (scope.isIngestionSuspended) {
    throw new ForbiddenError(
      "Ingestion suspended: the Developer monthly usage limit was reached. Upgrade the organization or wait for the next billing cycle.",
    );
  }
}
