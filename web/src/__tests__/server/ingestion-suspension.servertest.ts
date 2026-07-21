/** @jest-environment node */

import { throwIfIngestionSuspended } from "@/src/features/public-api/server/ingestionSuspension";
import { ForbiddenError } from "@langfuse/shared";

describe("Developer ingestion suspension", () => {
  it("allows writes while the organization is not blocked", () => {
    expect(() =>
      throwIfIngestionSuspended({ isIngestionSuspended: false }),
    ).not.toThrow();
  });

  it("uses the shared 403 error for every guarded write path", () => {
    try {
      throwIfIngestionSuspended({ isIngestionSuspended: true });
      throw new Error("Expected ingestion suspension to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error).toMatchObject({ httpCode: 403 });
    }
  });
});
