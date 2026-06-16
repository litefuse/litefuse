import { cors, runMiddleware } from "@/src/features/public-api/server/cors";
import { type NextApiRequest, type NextApiResponse } from "next";
import { z } from "zod/v4";
import {
  traceException,
  logger,
  getCurrentSpan,
  contextWithLangfuseProps,
  processEventBatch,
  eventTypes,
} from "@langfuse/shared/src/server";
import { telemetry } from "@/src/features/telemetry";
import { jsonSchema } from "@langfuse/shared";
import { isPrismaException } from "@/src/utils/exceptions";
import {
  MethodNotAllowedError,
  BaseError,
  UnauthorizedError,
} from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import { ApiAuthService } from "@/src/features/public-api/server/apiAuth";
import { RateLimitService } from "@/src/features/public-api/server/RateLimitService";
import * as opentelemetry from "@opentelemetry/api";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4.5mb",
    },
  },
};

/**
 * Litefuse Lightweight: this endpoint is intentionally narrowed.
 *
 * OTel-only refactor closed the legacy batch ingestion path for traces /
 * observations (spans / generations / agents / tools / etc.) — those MUST
 * go through /api/public/otel/v1/traces. But Langfuse-native concepts that
 * have no OTel equivalent still need to reach the server somehow, and the
 * v5 JS / v4 Python SDKs send them through this exact endpoint:
 *
 *   - score-create — v5 ScoreManager.handleFlush() batches score events
 *     here. There is no OTel "score" concept; this is the SDK-blessed
 *     path. Closing it removes score upload entirely.
 *   - sdk-log    — older SDKs ship self-telemetry through here.
 *     processEventBatch drops these (logged, no Doris write) — safe to
 *     accept so older clients don't get noisy 4xx errors.
 *
 * Everything else (trace-create / span-create / generation-create /
 * observation-create / *-update / agent/tool/chain/retriever-create / ...)
 * is rejected with 400 + an upgrade-to-OTel hint to preserve the OTel-only
 * invariant — they would otherwise re-introduce the v3 create/update
 * split race that the refactor eliminated.
 */
const ALLOWED_EVENT_TYPES = new Set<string>([
  eventTypes.SCORE_CREATE,
  eventTypes.SDK_LOG,
]);

const REJECT_MESSAGE =
  "Litefuse Lightweight only accepts score-create / sdk-log events on " +
  "/api/public/ingestion. Use OTel via /api/public/otel/v1/traces for " +
  "trace and observation events (Python SDK >= 4.0.0 or JS SDK >= 5.0.0).";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  try {
    await runMiddleware(req, res, cors);

    // add context of api call to the span
    const currentSpan = getCurrentSpan();

    // get x-langfuse-xxx headers and add them to the span
    Object.keys(req.headers).forEach((header) => {
      if (
        header.toLowerCase().startsWith("x-langfuse") ||
        header.toLowerCase().startsWith("x_langfuse")
      ) {
        currentSpan?.setAttributes({
          [`langfuse.header.${header.slice(11).toLowerCase().replaceAll("_", "-")}`]:
            req.headers[header],
        });
      }
    });

    if (req.method !== "POST") throw new MethodNotAllowedError();

    // CHECK AUTH FOR ALL EVENTS
    const authCheck = await new ApiAuthService(
      prisma,
    ).verifyAuthHeaderAndReturnScope(req.headers.authorization);

    if (!authCheck.validKey) {
      throw new UnauthorizedError(authCheck.error);
    }
    if (!authCheck.scope.projectId) {
      throw new UnauthorizedError(
        "Missing projectId in scope. Are you using an organization key?",
      );
    }

    const ctx = contextWithLangfuseProps({
      headers: req.headers,
      projectId: authCheck.scope.projectId,
    });
    // Execute the rest of the handler within the context
    return opentelemetry.context.with(ctx, async () => {
      try {
        const rateLimitCheck =
          await RateLimitService.getInstance().rateLimitRequest(
            authCheck.scope,
            "ingestion",
          );

        if (rateLimitCheck?.isRateLimited()) {
          return rateLimitCheck.sendRestResponseIfLimited(res);
        }
      } catch (e) {
        // If rate-limiter returns an error, we log it and continue processing.
        // This allows us to fail open instead of reject requests.
        logger.error("Error while rate limiting", e);
      }

      const batchType = z.object({
        batch: z.array(z.unknown()),
        metadata: jsonSchema.nullish(),
      });

      const parsedSchema = batchType.safeParse(req.body);

      if (!parsedSchema.success) {
        logger.info("Invalid request data", parsedSchema.error);
        return res.status(400).json({
          message: "Invalid request data",
          errors: parsedSchema.error.issues.map((issue) => issue.message),
        });
      }

      // Whitelist: reject the whole batch if it contains any non-allowed
      // event type. Doing this before processEventBatch keeps the OTel-only
      // contract crisp — clients get a single 400 with a clear message
      // rather than per-event 207 errors mixed with successes.
      const rejected = new Set<string>();
      for (const raw of parsedSchema.data.batch) {
        if (
          typeof raw === "object" &&
          raw !== null &&
          "type" in raw &&
          typeof (raw as { type: unknown }).type === "string"
        ) {
          const type = (raw as { type: string }).type;
          if (!ALLOWED_EVENT_TYPES.has(type)) {
            rejected.add(type);
          }
        } else {
          rejected.add("<missing-or-malformed-type>");
        }
      }
      if (rejected.size > 0) {
        return res.status(400).json({
          error: "UnsupportedEventTypes",
          message: REJECT_MESSAGE,
          rejectedTypes: Array.from(rejected),
        });
      }

      await telemetry();
      const result = await processEventBatch(
        parsedSchema.data.batch,
        authCheck,
      );
      return res.status(207).json(result);
    });
  } catch (error: unknown) {
    if (!(error instanceof UnauthorizedError)) {
      logger.error("error_handling_ingestion_event", error);
      traceException(error);
    }

    if (error instanceof BaseError) {
      return res.status(error.httpCode).json({
        error: error.name,
        message: error.message,
      });
    }

    if (isPrismaException(error)) {
      return res.status(500).json({
        error: "Internal Server Error",
      });
    }

    if (error instanceof z.ZodError) {
      logger.error(`Zod exception`, error.issues);
      return res.status(400).json({
        message: "Invalid request data",
        error: error.issues,
      });
    }

    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    res.status(500).json({
      message: "Invalid request data",
      errors: [errorMessage],
    });
  }
}
