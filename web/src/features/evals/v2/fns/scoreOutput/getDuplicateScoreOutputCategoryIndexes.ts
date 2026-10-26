import { getCategoricalCategoryRuleViolations } from "@langfuse/shared";

import { i18nKey } from "@/src/features/i18n/i18nKey";

export const DUPLICATE_CATEGORY_NAMES_MESSAGE = i18nKey(
  "Category names must be unique.",
);

export function getDuplicateScoreOutputCategoryIndexes(categories: string[]) {
  return getCategoricalCategoryRuleViolations(categories).flatMap(
    (violation) =>
      violation.type === "duplicate_value" &&
      categories[violation.index]?.trim()
        ? [violation.index]
        : [],
  );
}
