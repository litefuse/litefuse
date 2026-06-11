import {
  PatchSpansV1Body,
  PatchSpansV1Response,
  PostSpansV1Body,
  PostSpansV1Response,
} from "@/src/features/public-api/types/spans";
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
// v3-style /api/public/spans endpoint is gated off — clients must send
// spans through /api/public/otel/v1/traces with Python SDK >= 4.0.0 or
// JS SDK >= 5.0.0. The original handler bodies are kept as reference;
// the throw at the top short-circuits before processEventBatch ever
// runs. The early-throw goes through a function so TypeScript does not
// constant-fold and mark the rest of the body unreachable — that's how
// the original code stays type-checked while never executing.
const OTEL_ONLY_MESSAGE =
  "Master fork is OTel-only for spans. Send spans via " +
  "/api/public/otel/v1/traces (Python SDK >= 4.0.0 or JS SDK >= 5.0.0).";

const rejectLegacy = (): never => {
  throw new InvalidRequestError(OTEL_ONLY_MESSAGE);
};

export default withMiddlewares({
  POST: createAuthedProjectAPIRoute({
    name: "Create Span (Legacy)",
    bodySchema: PostSpansV1Body,
    responseSchema: PostSpansV1Response,
    fn: async ({ body, auth, res }) => {
      rejectLegacy();

      const event = {
        id: v4(),
        type: eventTypes.OBSERVATION_CREATE,
        timestamp: new Date().toISOString(),
        body: {
          ...body,
          type: "SPAN",
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
        logger.error("Failed to create span", { result });
        throw new Error("Failed to create span");
      }
      return { id: event.body.id };
    },
  }),
  PATCH: createAuthedProjectAPIRoute({
    name: "Update Span (Legacy)",
    bodySchema: PatchSpansV1Body,
    responseSchema: PatchSpansV1Response,
    fn: async ({ body, auth, res }) => {
      rejectLegacy();

      const event = {
        id: v4(),
        type: eventTypes.OBSERVATION_UPDATE,
        timestamp: new Date().toISOString(),
        body: {
          ...body,
          id: body.spanId,
          type: "SPAN",
        },
      };
      const result = await processEventBatch([event], auth);
      if (result.errors.length > 0) {
        const error = result.errors[0];
        res
          .status(error.status)
          .json({ message: error.error ?? error.message });
        return { id: "" }; // dummy return
      }
      if (result.successes.length !== 1) {
        logger.error("Failed to update span", { result });
        throw new Error("Failed to update span");
      }
      return { id: event.body.id };
    },
  }),
});
