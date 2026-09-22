import { i18nKey } from "./i18nKey";

/**
 * Object, field and filter-column labels for the evaluator forms and tables.
 *
 * They are declared in `packages/shared`
 * (`features/evals/types.ts`, `features/evals/observationForEval.ts`) next to
 * the ids the form stores, so they cannot be wrapped at their declaration.
 * `variable-mapping-card.tsx` translates them at the render site; this
 * inventory is what stops `removeUnusedKeys` from dropping the keys.
 *
 * Regenerate the candidate list with:
 *   grep -nE '(display|name): "' packages/shared/src/features/evals/types.ts \
 *     packages/shared/src/features/evals/observationForEval.ts
 */
export const SHARED_EVAL_LABELS = [
  // availableTraceEvalVariables / availableDatasetEvalVariables `display`
  i18nKey("Agent"),
  i18nKey("Chain"),
  i18nKey("Embedding"),
  i18nKey("Evaluator"),
  i18nKey("Event"),
  i18nKey("Generation"),
  i18nKey("Guardrail"),
  i18nKey("Retriever"),
  i18nKey("Span"),
  i18nKey("Tool"),
  i18nKey("Trace"),
  i18nKey("Dataset item"),
  // OBSERVATION_VARIABLES `display`
  i18nKey("Observation"),
  // availableColumns `name`
  i18nKey("Input"),
  i18nKey("Output"),
  i18nKey("Metadata"),
  i18nKey("Expected output"),
  i18nKey("Expected Output"),
  i18nKey("Tool Calls"),
  i18nKey("Tool Definitions"),
  i18nKey("Tool Call Names"),
  i18nKey("Model"),
  // observationEvalFilterColumns `name` (the rest are already listed above)
  i18nKey("Cost Details"),
  i18nKey("Usage Details"),
  i18nKey("Model Parameters"),
  i18nKey("Parent Observation"),
  i18nKey("Type"),
  i18nKey("Level"),
  i18nKey("Version"),
  i18nKey("Trace Name"),
  i18nKey("User ID"),
  i18nKey("Session ID"),
  i18nKey("Tags"),
  i18nKey("Name"),
  i18nKey("Environment"),
  i18nKey("Dataset"),
];
