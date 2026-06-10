import { prisma } from "@langfuse/shared/src/db";
import {
  GetObservationV1Query,
  GetObservationV1Response,
  transformDbToApiObservation,
} from "@/src/features/public-api/types/observations";
import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import { createAuthedProjectAPIRoute } from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
import { LangfuseNotFoundError } from "@langfuse/shared";
import {
  enrichObservationWithModelData,
  getObservationById,
  getObservationByIdFromEventsTable,
} from "@langfuse/shared/src/server";
import { env } from "@/src/env.mjs";

export default withMiddlewares({
  GET: createAuthedProjectAPIRoute({
    name: "Get Observation",
    querySchema: GetObservationV1Query,
    responseSchema: GetObservationV1Response,
    fn: async ({ query, auth }) => {
      // Use events table if query parameter is explicitly set, otherwise use environment variable
      const useEventsTable =
        query.useEventsTable !== undefined && query.useEventsTable !== null
          ? query.useEventsTable === true
          : env.LITEFUSE_ENABLE_EVENTS_TABLE_OBSERVATIONS;

      const dorisObservation = useEventsTable
        ? await getObservationByIdFromEventsTable({
            id: query.observationId,
            projectId: auth.scope.projectId,
            fetchWithInputOutput: true,
          })
        : await getObservationById({
            id: query.observationId,
            projectId: auth.scope.projectId,
            fetchWithInputOutput: true,
          });

      if (!dorisObservation) {
        throw new LangfuseNotFoundError(
          "Observation not found within authorized project",
        );
      }

      const model = dorisObservation.internalModelId
        ? await prisma.model.findFirst({
            where: {
              AND: [
                {
                  id: dorisObservation.internalModelId,
                },
                {
                  OR: [
                    {
                      projectId: auth.scope.projectId,
                    },
                    {
                      projectId: null,
                    },
                  ],
                },
              ],
            },
            include: {
              Price: true,
            },
            orderBy: {
              projectId: {
                sort: "desc",
                nulls: "last",
              },
            },
          })
        : undefined;

      const observation = {
        ...dorisObservation,
        ...enrichObservationWithModelData(model),
      };

      if (!observation) {
        throw new LangfuseNotFoundError(
          "Observation not found within authorized project",
        );
      }
      return transformDbToApiObservation(observation);
    },
  }),
});
