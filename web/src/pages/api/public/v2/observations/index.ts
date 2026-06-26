import { getObservationsV2FromEventsTableForPublicApi } from "@langfuse/shared/src/server";
import { LangfuseNotFoundError } from "@langfuse/shared";

import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import { createAuthedProjectAPIRoute } from "@/src/features/public-api/server/createAuthedProjectAPIRoute";
import { env } from "@/src/env.mjs";

import {
  GetObservationsV2Query,
  GetObservationsV2Response,
  OBSERVATION_FIELD_GROUPS,
  encodeCursor,
} from "@/src/features/public-api/types/observations";

const normalizeOptionalString = (value: string | null | undefined) => {
  if (typeof value !== "string") {
    return value ?? undefined;
  }

  return value.trim() === "" ? undefined : value;
};

const normalizeOptionalStringOrArray = (
  value: string | string[] | null | undefined,
) => {
  if (Array.isArray(value)) {
    const filtered = value.filter((item) => item.trim() !== "");
    return filtered.length > 0 ? filtered : undefined;
  }

  return normalizeOptionalString(value);
};

export default withMiddlewares({
  GET: createAuthedProjectAPIRoute({
    name: "Get Observations V2",
    querySchema: GetObservationsV2Query,
    responseSchema: GetObservationsV2Response,
    fn: async ({ query, auth }) => {
      if (env.LITEFUSE_ENABLE_EVENTS_TABLE_V2_APIS !== "true") {
        throw new LangfuseNotFoundError(
          "v2 APIs are currently in beta and only available on Litefuse Cloud",
        );
      }

      // Extract field groups and metadata expansion keys
      const fieldGroups = query.fields ?? undefined;
      const expandMetadataKeys = query.expandMetadata ?? undefined;

      const filterProps = {
        projectId: auth.scope.projectId,
        page: 0, // v2 doesn't use page-based pagination
        limit: query.limit,
        traceId: normalizeOptionalString(query.traceId),
        userId: normalizeOptionalString(query.userId),
        level: query.level ?? undefined,
        name: normalizeOptionalString(query.name),
        type: query.type ?? undefined,
        environment: normalizeOptionalStringOrArray(query.environment),
        parentObservationId: normalizeOptionalString(query.parentObservationId),
        fromStartTime: query.fromStartTime ?? undefined,
        toStartTime: query.toStartTime ?? undefined,
        version: normalizeOptionalString(query.version),
        advancedFilters: query.filter,
        cursor: query.cursor ?? undefined,
        fields: fieldGroups,
        expandMetadataKeys,
      };

      // Fetch observations from events table with field groups applied at query time
      const items = await getObservationsV2FromEventsTableForPublicApi({
        ...filterProps,
        fields: filterProps.fields ?? [...OBSERVATION_FIELD_GROUPS],
      });

      // Determine if there are more results (we fetched limit+1)
      const hasMore = items.length > query.limit;
      const dataToReturn = hasMore ? items.slice(0, query.limit) : items;

      // Normalize wire format for v2:
      // - empty parent_observation_id -> null (v1 parity)
      // - Decimal price fields -> string (stable serialized contract)
      const transformedItems = dataToReturn.map((item) => {
        const { inputPrice, outputPrice, totalPrice, modelId, ...rest } = item;

        return {
          ...rest,
          parentObservationId:
            item.parentObservationId === "" ? null : item.parentObservationId,
          tags: item.tags ?? undefined,
          ...(Object.prototype.hasOwnProperty.call(item, "modelId") && {
            modelId: modelId ?? null,
          }),
          ...(Object.prototype.hasOwnProperty.call(item, "inputPrice") && {
            inputPrice: inputPrice?.toString() ?? null,
          }),
          ...(Object.prototype.hasOwnProperty.call(item, "outputPrice") && {
            outputPrice: outputPrice?.toString() ?? null,
          }),
          ...(Object.prototype.hasOwnProperty.call(item, "totalPrice") && {
            totalPrice: totalPrice?.toString() ?? null,
          }),
        };
      });

      // Generate cursor if there are more results
      const lastItemIdx = dataToReturn.length - 1;
      const meta =
        hasMore && dataToReturn.length > 0
          ? {
              cursor: encodeCursor({
                lastStartTimeTo: dataToReturn[lastItemIdx].startTime,
                lastTraceId: dataToReturn[lastItemIdx].traceId ?? "",
                lastId: dataToReturn[lastItemIdx].id,
              }),
            }
          : {};

      return {
        data: transformedItems,
        meta,
      };
    },
  }),
});
