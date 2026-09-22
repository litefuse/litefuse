import { i18nKey } from "./i18nKey";

/**
 * Validation messages declared in `packages/shared`.
 *
 * That package is shared with the worker and cannot import from the web app,
 * so its zod messages stay plain strings there. `FormMessage` already runs
 * `t(error.message)`, so they only need to exist as keys — this inventory is
 * what stops `removeUnusedKeys` from dropping them on the next extraction.
 *
 * Only messages a person can actually hit in a form belong here. Messages
 * that only ever answer an API call are left untranslated on purpose; see the
 * error-reporting rule in the README.
 *
 * Regenerate the candidate list with:
 *   grep -rnoE '(message:|\.min\([0-9]+,|\.max\([0-9]+,) *"[^"]{5,}"' packages/shared/src
 */
export const SHARED_VALIDATION_MESSAGES = [
  i18nKey("Text cannot be empty"),
  i18nKey("Text cannot contain HTML tags"),
  i18nKey("Name cannot be empty"),
  i18nKey("Name exceeds maximum length of 100 characters"),
  i18nKey("Key is required"),
  i18nKey("View name is required"),
  i18nKey("Widget name is required"),
  i18nKey("Maximum length is 40 characters"),
  i18nKey("Pattern cannot be empty"),
  i18nKey("Pattern exceeds maximum length of 200 characters"),
  i18nKey("Maximum value must be greater than Minimum value"),
  i18nKey("At least 1 score config must be selected"),
  i18nKey("At least one entry is required"),
  i18nKey("Must be a valid JSON Schema"),
  i18nKey("Parameters must be valid JSON"),
  i18nKey("Must have at least one tool call"),
  i18nKey("Priority must be non-negative"),
  i18nKey("Priority cannot exceed 999"),
  i18nKey("Position must be >= 1 for nth selection"),
  i18nKey("ID cannot contain carriage return characters"),
  i18nKey("Value must be either 0 or 1"),
  i18nKey(
    "Value must be a number equal to either 0 or 1 for data type BOOLEAN",
  ),
  i18nKey(
    "Invalid regex pattern: must be valid regex and not cause catastrophic backtracking",
  ),
  i18nKey("Each rangeStart must be less than corresponding rangeEnd"),
  // Evaluator status banners, shown on the evaluator detail page.
  i18nKey(
    "Evaluator paused: LLM authentication failed. Update the LLM connection used by this evaluator and then reactivate it.",
  ),
  i18nKey(
    "Evaluator paused: model not found or unavailable. Update the evaluator template or default evaluation model, then reactivate it.",
  ),
  i18nKey(
    "Evaluator paused: no LLM connection found for the provider used by this evaluator. Add or restore the LLM connection, then reactivate it.",
  ),
  i18nKey(
    "Evaluator paused: no default evaluation model is configured. Set a default evaluation model or update the evaluator template, then reactivate it.",
  ),
  i18nKey(
    "Evaluator paused: no valid evaluation model is configured. Update the evaluator template or default evaluation model, then reactivate it.",
  ),
  i18nKey(
    "Evaluator paused: provider account setup is incomplete. Complete the provider setup and then reactivate the evaluator.",
  ),
  // EVALUATOR_BLOCK_METADATA.shortLabel, rendered by `evaluator-paused-callout`
  i18nKey("Authentication failed"),
  i18nKey("LLM connection missing"),
  i18nKey("Default evaluation model missing"),
  i18nKey("Evaluation model invalid"),
  i18nKey("Model unavailable"),
  i18nKey("Provider account setup incomplete"),
] as const;
