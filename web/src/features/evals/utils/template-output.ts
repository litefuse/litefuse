import {
  PersistedEvalOutputDefinitionSchema,
  resolvePersistedEvalOutputDefinition,
  ScoreDataTypeEnum,
} from "@langfuse/shared";

export const getTemplateResultType = (outputSchema: unknown) => {
  if (typeof outputSchema !== "object" || outputSchema === null) {
    return "Unknown";
  }

  const hasStructuredOutputMarkers =
    "version" in outputSchema || "dataType" in outputSchema;
  const hasLegacyOutputMarkers =
    "reasoning" in outputSchema || "score" in outputSchema;

  if (!hasStructuredOutputMarkers && !hasLegacyOutputMarkers) {
    return "Unknown";
  }

  const parsedOutputDefinition =
    PersistedEvalOutputDefinitionSchema.safeParse(outputSchema);

  if (!parsedOutputDefinition.success) {
    return "Unknown";
  }

  switch (
    resolvePersistedEvalOutputDefinition(parsedOutputDefinition.data).dataType
  ) {
    case ScoreDataTypeEnum.CATEGORICAL:
      return "Categorical";
    case ScoreDataTypeEnum.BOOLEAN:
      return "Boolean";
    default:
      return "Numeric";
  }
};
