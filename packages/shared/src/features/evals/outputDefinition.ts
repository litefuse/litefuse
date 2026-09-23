import { z } from "zod/v4";
import { ScoreDataTypeEnum } from "../../domain/scores";

export const EvalOutputDataTypeSchema = z.enum([
  ScoreDataTypeEnum.NUMERIC,
  ScoreDataTypeEnum.CATEGORICAL,
  ScoreDataTypeEnum.BOOLEAN,
]);
export type EvalOutputDataType = z.infer<typeof EvalOutputDataTypeSchema>;

export const LegacyEvalOutputDefinitionSchema = z
  .object({ reasoning: z.string().default(""), score: z.string().default("") })
  .refine((value) => value.reasoning.length > 0 || value.score.length > 0, {
    message: "Legacy eval output definition requires score or reasoning",
  });
export type LegacyEvalOutputDefinition = z.infer<
  typeof LegacyEvalOutputDefinitionSchema
>;

const EvalOutputFieldDefinitionSchema = z.object({
  description: z.string().trim().min(1),
});
const EvalCategoricalCategorySchema = z.string().trim().min(1);
export const MinimumCategoricalCategoryCount = 2;
export const getMinimumCategoricalCategoriesMessage = () =>
  `Add at least ${MinimumCategoricalCategoryCount} categories`;
export type CategoricalCategoryRuleViolation =
  | { type: "minimum_count"; minimumCount: number }
  | { type: "duplicate_value"; index: number };

export function getCategoricalCategoryRuleViolations(categories: string[]) {
  const violations: CategoricalCategoryRuleViolation[] = [];
  if (categories.length < MinimumCategoricalCategoryCount)
    violations.push({
      type: "minimum_count",
      minimumCount: MinimumCategoricalCategoryCount,
    });
  const seenValues = new Set<string>();
  categories.forEach((category, index) => {
    const normalizedValue = category.trim();
    if (seenValues.has(normalizedValue))
      violations.push({ type: "duplicate_value", index });
    else seenValues.add(normalizedValue);
  });
  return violations;
}

export const NumericEvalOutputDefinitionV2Schema = z.object({
  version: z.literal(2),
  dataType: z.literal(ScoreDataTypeEnum.NUMERIC),
  reasoning: EvalOutputFieldDefinitionSchema,
  score: EvalOutputFieldDefinitionSchema,
});
export type NumericEvalOutputDefinitionV2 = z.infer<
  typeof NumericEvalOutputDefinitionV2Schema
>;
export const BooleanEvalOutputDefinitionV2Schema = z.object({
  version: z.literal(2),
  dataType: z.literal(ScoreDataTypeEnum.BOOLEAN),
  reasoning: EvalOutputFieldDefinitionSchema,
  score: EvalOutputFieldDefinitionSchema,
});
export type BooleanEvalOutputDefinitionV2 = z.infer<
  typeof BooleanEvalOutputDefinitionV2Schema
>;
export const CategoricalEvalOutputDefinitionV2Schema = z
  .object({
    version: z.literal(2),
    dataType: z.literal(ScoreDataTypeEnum.CATEGORICAL),
    reasoning: EvalOutputFieldDefinitionSchema,
    score: z.object({
      description: z.string().trim().min(1),
      categories: z.array(EvalCategoricalCategorySchema),
      shouldAllowMultipleMatches: z.boolean().default(false),
    }),
  })
  .superRefine((value, ctx) => {
    getCategoricalCategoryRuleViolations(value.score.categories).forEach(
      (violation) => {
        if (violation.type === "minimum_count")
          ctx.addIssue({
            code: "custom",
            message: getMinimumCategoricalCategoriesMessage(),
            path: ["score", "categories"],
          });
        else
          ctx.addIssue({
            code: "custom",
            message: "Categories must be unique",
            path: ["score", "categories", violation.index],
          });
      },
    );
  });
export type CategoricalEvalOutputDefinitionV2 = z.infer<
  typeof CategoricalEvalOutputDefinitionV2Schema
>;
export const PersistedEvalOutputDefinitionSchema = z.union([
  LegacyEvalOutputDefinitionSchema,
  NumericEvalOutputDefinitionV2Schema,
  BooleanEvalOutputDefinitionV2Schema,
  CategoricalEvalOutputDefinitionV2Schema,
]);
export type PersistedEvalOutputDefinition = z.infer<
  typeof PersistedEvalOutputDefinitionSchema
>;

export type ResolvedEvalOutputDefinition =
  | {
      dataType: typeof ScoreDataTypeEnum.NUMERIC;
      reasoningDescription: string;
      scoreDescription: string;
    }
  | {
      dataType: typeof ScoreDataTypeEnum.BOOLEAN;
      reasoningDescription: string;
      scoreDescription: string;
    }
  | {
      dataType: typeof ScoreDataTypeEnum.CATEGORICAL;
      reasoningDescription: string;
      scoreDescription: string;
      categories: string[];
      shouldAllowMultipleMatches: boolean;
    };
export type EvalOutputResult =
  | {
      dataType: typeof ScoreDataTypeEnum.NUMERIC;
      score: number;
      reasoning: string;
    }
  | {
      dataType: typeof ScoreDataTypeEnum.BOOLEAN;
      score: boolean;
      reasoning: string;
    }
  | {
      dataType: typeof ScoreDataTypeEnum.CATEGORICAL;
      matches: string[];
      reasoning: string;
    };

export function resolvePersistedEvalOutputDefinition(
  outputDefinition: PersistedEvalOutputDefinition,
): ResolvedEvalOutputDefinition {
  if (!("version" in outputDefinition))
    return {
      dataType: ScoreDataTypeEnum.NUMERIC,
      reasoningDescription: outputDefinition.reasoning,
      scoreDescription: outputDefinition.score,
    };
  if (
    outputDefinition.dataType === ScoreDataTypeEnum.NUMERIC ||
    outputDefinition.dataType === ScoreDataTypeEnum.BOOLEAN
  )
    return {
      dataType: outputDefinition.dataType,
      reasoningDescription: outputDefinition.reasoning.description,
      scoreDescription: outputDefinition.score.description,
    };
  return {
    dataType: ScoreDataTypeEnum.CATEGORICAL,
    reasoningDescription: outputDefinition.reasoning.description,
    scoreDescription: outputDefinition.score.description,
    categories: outputDefinition.score.categories,
    shouldAllowMultipleMatches:
      outputDefinition.score.shouldAllowMultipleMatches,
  };
}

export const createNumericEvalOutputDefinition = (params: {
  reasoningDescription: string;
  scoreDescription: string;
}) =>
  NumericEvalOutputDefinitionV2Schema.parse({
    version: 2,
    dataType: ScoreDataTypeEnum.NUMERIC,
    reasoning: { description: params.reasoningDescription },
    score: { description: params.scoreDescription },
  });
export const createBooleanEvalOutputDefinition = (params: {
  reasoningDescription: string;
  scoreDescription: string;
}) =>
  BooleanEvalOutputDefinitionV2Schema.parse({
    version: 2,
    dataType: ScoreDataTypeEnum.BOOLEAN,
    reasoning: { description: params.reasoningDescription },
    score: { description: params.scoreDescription },
  });
export const createCategoricalEvalOutputDefinition = (params: {
  reasoningDescription: string;
  scoreDescription: string;
  categories: string[];
  shouldAllowMultipleMatches?: boolean;
}) =>
  CategoricalEvalOutputDefinitionV2Schema.parse({
    version: 2,
    dataType: ScoreDataTypeEnum.CATEGORICAL,
    reasoning: { description: params.reasoningDescription },
    score: {
      description: params.scoreDescription,
      categories: params.categories,
      shouldAllowMultipleMatches: params.shouldAllowMultipleMatches ?? false,
    },
  });

function buildResultSchemaForResolvedOutputDefinition(
  resolved: ResolvedEvalOutputDefinition,
) {
  const reasoning = z.string().describe(resolved.reasoningDescription);
  if (resolved.dataType === ScoreDataTypeEnum.CATEGORICAL) {
    const [firstCategory, ...remainingCategories] = resolved.categories;
    if (!firstCategory)
      throw new Error(
        "Categorical eval output definition requires at least one category",
      );
    const category = z.enum([firstCategory, ...remainingCategories]);
    const score = resolved.shouldAllowMultipleMatches
      ? z
          .array(category)
          .min(1)
          .max(remainingCategories.length + 1)
          .superRefine((categories, ctx) => {
            if (new Set(categories).size !== categories.length)
              ctx.addIssue({
                code: "custom",
                message: "Score categories must be unique",
              });
          })
      : category;
    return z.object({
      reasoning,
      score: score.describe(resolved.scoreDescription),
    });
  }
  return z.object({
    reasoning,
    score: (resolved.dataType === ScoreDataTypeEnum.BOOLEAN
      ? z.boolean()
      : z.number()
    ).describe(resolved.scoreDescription),
  });
}

export const buildEvalOutputResultSchema = (
  outputDefinition: PersistedEvalOutputDefinition,
) =>
  buildResultSchemaForResolvedOutputDefinition(
    resolvePersistedEvalOutputDefinition(outputDefinition),
  );
export function compilePersistedEvalOutputDefinition(
  outputDefinition: PersistedEvalOutputDefinition,
) {
  const resolvedOutputDefinition =
    resolvePersistedEvalOutputDefinition(outputDefinition);
  return {
    resolvedOutputDefinition,
    outputResultSchema: buildResultSchemaForResolvedOutputDefinition(
      resolvedOutputDefinition,
    ),
  };
}
export type CompiledEvalOutputDefinition = ReturnType<
  typeof compilePersistedEvalOutputDefinition
>;

export function validateEvalOutputResult(params: {
  response: unknown;
  compiledOutputDefinition: CompiledEvalOutputDefinition;
}):
  | { success: true; data: EvalOutputResult }
  | { success: false; error: string } {
  const result = params.compiledOutputDefinition.outputResultSchema.safeParse(
    params.response,
  );
  if (!result.success) return { success: false, error: result.error.message };
  const { dataType } = params.compiledOutputDefinition.resolvedOutputDefinition;
  if (dataType === ScoreDataTypeEnum.CATEGORICAL)
    return {
      success: true,
      data: {
        dataType,
        matches: Array.isArray(result.data.score)
          ? result.data.score
          : [result.data.score as string],
        reasoning: result.data.reasoning,
      },
    };
  if (dataType === ScoreDataTypeEnum.BOOLEAN)
    return {
      success: true,
      data: {
        dataType,
        score: result.data.score as boolean,
        reasoning: result.data.reasoning,
      },
    };
  return {
    success: true,
    data: {
      dataType,
      score: result.data.score as number,
      reasoning: result.data.reasoning,
    },
  };
}
