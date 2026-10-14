import { env } from "@/src/env.mjs";
import {
  createTRPCRouter,
  protectedGetTraceProcedure,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { LangfuseNotFoundError, parseIO } from "@langfuse/shared";
import {
  getObservationById,
  getObservationByIdFromEventsTable,
} from "@langfuse/shared/src/server";
import { z } from "zod/v4";
import { toDomainWithStringifiedMetadata } from "@/src/utils/clientSideDomainTypes";
import { observationBatchPreviewInput } from "@/src/features/observations/lib/observationBatchPreview";
import { getObservationBatchPreviews } from "@/src/features/observations/server/observationBatchPreviews";

export const observationsRouter = createTRPCRouter({
  batchPreviews: protectedProjectProcedure
    .input(observationBatchPreviewInput)
    .query(({ input, ctx }) =>
      getObservationBatchPreviews({
        projectId: ctx.session.projectId,
        observations: input.observations,
        includeMetadata: input.includeMetadata,
      }),
    ),
  byId: protectedGetTraceProcedure
    .input(
      z.object({
        observationId: z.string(),
        traceId: z.string(), // required for protectedGetTraceProcedure
        projectId: z.string(), // required for protectedGetTraceProcedure
        startTime: z.date().nullish(),
        verbosity: z.enum(["compact", "truncated", "full"]).default("full"),
      }),
    )
    .query(async ({ input }) => {
      const queryOpts = {
        id: input.observationId,
        projectId: input.projectId,
        // "compact" (the observations-list cell) only needs input_trim/
        // output_trim, so skip reading the full input/output Variant from Doris.
        fetchWithInputOutput: input.verbosity !== "compact",
        traceId: input.traceId,
        startTime: input.startTime ?? undefined,
        renderingProps: {
          truncated: input.verbosity === "truncated",
          shouldJsonParse: false,
        },
      };
      const obs =
        env.LITEFUSE_ENABLE_EVENTS_TABLE_OBSERVATIONS === "true"
          ? await getObservationByIdFromEventsTable(queryOpts)
          : await getObservationById(queryOpts);
      if (!obs) {
        throw new LangfuseNotFoundError(
          "Observation not found within authorized project",
        );
      }
      return {
        ...toDomainWithStringifiedMetadata(obs),
        // "compact" is the observations-list cell's preview request — serve the
        // precomputed input_trim/output_trim (migration 0037) instead of parsing
        // the full Variant. full/truncated callers keep the full I/O.
        input:
          input.verbosity === "compact"
            ? ((obs as { input_trim?: string | null }).input_trim ?? null)
            : (parseIO(obs.input, input.verbosity) as string),
        output:
          input.verbosity === "compact"
            ? ((obs as { output_trim?: string | null }).output_trim ?? null)
            : (parseIO(obs.output, input.verbosity) as string),
        internalModel: obs?.internalModelId,
      };
    }),
});
