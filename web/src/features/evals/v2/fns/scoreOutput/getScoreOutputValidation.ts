/* eslint-disable no-nested-ternary */
import { ScoreDataTypeEnum } from "@langfuse/shared";

import {
  DUPLICATE_CATEGORY_NAMES_MESSAGE,
  getDuplicateScoreOutputCategoryIndexes,
} from "@/src/features/evals/v2/fns/scoreOutput/getDuplicateScoreOutputCategoryIndexes";
import type { ScoreOutputSelectorState } from "@/src/features/evals/v2/scoreOutputTypes";
import { i18nKey } from "@/src/features/i18n/i18nKey";

const EMPTY_CATEGORY_NAME_MESSAGE = i18nKey("Category names cannot be empty.");
// Mirrors `getMinimumCategoricalCategoriesMessage()` from @langfuse/shared (the
// minimum is `MinimumCategoricalCategoryCount`, 2) with the count spelled out so
// the string can be a static translation key.
const MINIMUM_CATEGORY_COUNT_MESSAGE = i18nKey("Add at least 2 categories.");

export function getScoreOutputValidation(state: ScoreOutputSelectorState) {
  if (state.dataType !== ScoreDataTypeEnum.CATEGORICAL) {
    return { categoryWarnings: [], reason: null };
  }

  const duplicateIndexes = new Set(
    getDuplicateScoreOutputCategoryIndexes(
      state.choices.map(({ label }) => label),
    ),
  );
  const categoryWarnings = state.choices.map(({ label }, index) =>
    !label.trim()
      ? EMPTY_CATEGORY_NAME_MESSAGE
      : duplicateIndexes.has(index)
        ? DUPLICATE_CATEGORY_NAMES_MESSAGE
        : null,
  );

  return {
    categoryWarnings,
    reason:
      categoryWarnings.find((warning) => warning !== null) ??
      (state.choices.length < 2 ? MINIMUM_CATEGORY_COUNT_MESSAGE : null),
  };
}
