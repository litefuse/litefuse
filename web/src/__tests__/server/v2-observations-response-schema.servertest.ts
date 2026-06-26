/** @jest-environment node */

import { GetObservationsV2Response } from "@/src/features/public-api/types/observations";

describe("GetObservationsV2Response", () => {
  it("accepts usage pricing tier and trace context fields", () => {
    const parsed = GetObservationsV2Response.parse({
      data: [
        {
          id: "obs-1",
          traceId: "trace-1",
          startTime: "2026-05-15T10:00:00.000Z",
          endTime: "2026-05-15T10:00:02.000Z",
          projectId: "project-1",
          parentObservationId: null,
          type: "GENERATION",
          usagePricingTierName: "Standard",
          traceName: "checkout-trace",
          tags: ["prod", "checkout"],
          release: "2026.05.15",
          inputPrice: "0.03",
          outputPrice: "0.06",
          totalPrice: "0.09",
        },
      ],
      meta: {},
    });

    expect(parsed.data[0].usagePricingTierName).toBe("Standard");
    expect(parsed.data[0].traceName).toBe("checkout-trace");
    expect(parsed.data[0].tags).toEqual(["prod", "checkout"]);
    expect(parsed.data[0].release).toBe("2026.05.15");
  });
});
