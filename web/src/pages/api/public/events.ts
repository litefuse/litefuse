import {
  PostEventsV1Body,
  PostEventsV1Response,
} from "@/src/features/public-api/types/events";
import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import { createAuthedProjectAPIRoute } from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
import {
  eventTypes,
  logger,
  processEventBatch,
} from "@langfuse/shared/src/server";
import { InvalidRequestError } from "@langfuse/shared";
import { v4 } from "uuid";

// Master fork is OTel-only for trace/observation ingestion. The legacy
// v3-style /api/public/events endpoint is gated off — clients must emit
// EVENT spans through /api/public/otel/v1/traces. Handler body is
// preserved for reference.
const OTEL_ONLY_MESSAGE =
  "Master fork is OTel-only for events. Send EVENT spans via " +
  "/api/public/otel/v1/traces (Python SDK >= 4.0.0 or JS SDK >= 5.0.0).";

const rejectLegacy = (): never => {
  throw new InvalidRequestError(OTEL_ONLY_MESSAGE);
};

export default withMiddlewares({
  POST: createAuthedProjectAPIRoute({
    name: "Create Event",
    bodySchema: PostEventsV1Body,
    responseSchema: PostEventsV1Response,
    fn: async ({ body, auth, res }) => {
      rejectLegacy();
      const event = {
        id: v4(),
        type: eventTypes.OBSERVATION_CREATE,
        timestamp: new Date().toISOString(),
        body: {
          ...body,
          type: "EVENT",
        },
      };
      if (!event.body.id) {
        event.body.id = v4();
      }
      const result = await processEventBatch([event], auth);
      if (result.errors.length > 0) {
        const error = result.errors[0];
        res
          .status(error.status)
          .json({ message: error.error ?? error.message });
        return { id: "" }; // dummy return
      }
      if (result.successes.length !== 1) {
        logger.error("Failed to create event", { result });
        throw new Error("Failed to create event");
      }
      return { id: event.body.id };
    },
  }),
});
