import { i18nKey } from "@/src/features/i18n/i18nKey";
import { z } from "zod/v4";
import { type TFunction } from "i18next";
import {
  singleFilter,
  type langfuseObjects,
  TimeScopeSchema,
  wipVariableMapping,
} from "@langfuse/shared";

// Legacy eval targets (TRACE, DATASET) use full variable mapping UI with object selector
// Modern eval targets (EVENT, EXPERIMENT) use simplified UI with just column selection
export const isLegacyEvalTarget = (target: string): boolean =>
  target === "trace" || target === "dataset";

export const evalConfigFormSchema = z.object({
  scoreName: z.string(),
  target: z.string(),
  filter: z.array(singleFilter).nullable(), // reusing the filter type from the tables
  mapping: z.array(wipVariableMapping),
  sampling: z.coerce.number().gt(0).lte(1),
  delay: z.coerce.number().min(0).optional().default(10),
  timeScope: TimeScopeSchema,
  runOnLive: z.boolean().optional().default(true),
});

export type EvalFormType = z.infer<typeof evalConfigFormSchema>;

export type LangfuseObject = (typeof langfuseObjects)[number];

export type VariableMapping = z.infer<typeof wipVariableMapping>;

export const inferDefaultMapping = (
  _variable: string,
): Pick<VariableMapping, "selectedColumnId"> => {
  return {
    selectedColumnId: undefined,
  };
};

export const createDefaultFormMappings = (
  variables: string[],
  target: string,
): z.infer<typeof wipVariableMapping>[] =>
  variables.map((templateVariable) => ({
    templateVariable,
    langfuseObject: isLegacyEvalTarget(target) ? "trace" : undefined,
    objectName: isLegacyEvalTarget(target) ? null : undefined,
    jsonSelector: null,
    ...inferDefaultMapping(templateVariable),
  }));

export const fieldHasJsonSelectorOption = (
  selectedColumnId: string | undefined | null,
): boolean =>
  selectedColumnId === "input" ||
  selectedColumnId === "output" ||
  selectedColumnId === "metadata" ||
  selectedColumnId === "expected_output" ||
  selectedColumnId === "experiment_item_expected_output" ||
  selectedColumnId === "expectedOutput" ||
  selectedColumnId === "experimentItemExpectedOutput";

/**
 * The noun used for the evaluator's target inside sentences, so it has to be
 * translated. An unknown target falls back to the raw value, as before.
 */
/** The i18n key for an evaluator target, or the raw value when unknown. */
export const evaluatorTargetLabelKey = (target: string): string => {
  switch (target) {
    case "trace":
      return i18nKey("traces");
    case "event":
      return i18nKey("observations");
    case "dataset":
      return i18nKey("dataset run items");
    case "experiment":
      return i18nKey("experiments");
    default:
      return target;
  }
};

export const getTargetDisplayName = (target: string, t: TFunction): string =>
  t(evaluatorTargetLabelKey(target));
