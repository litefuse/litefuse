import { i18nKey } from "@/src/features/i18n/i18nKey";

/**
 * Filter operators are enum values: they live in the filter state, travel in
 * the URL and reach the API, so they are never translated where they are
 * declared. These are the labels shown for them, applied at the render site.
 *
 * Symbolic operators (=, >, <=, <>) read the same in every language and are
 * deliberately absent; the lookup falls back to the raw value.
 */
const OPERATOR_LABELS: Record<string, string> = {
  contains: i18nKey("contains"),
  "does not contain": i18nKey("does not contain"),
  "starts with": i18nKey("starts with"),
  "ends with": i18nKey("ends with"),
  "any of": i18nKey("any of"),
  "none of": i18nKey("none of"),
  "all of": i18nKey("all of"),
  "is null": i18nKey("is null"),
  "is not null": i18nKey("is not null"),
};

/** The key for an operator, or the operator itself when it is symbolic. */
export function operatorLabelKey(operator: string): string {
  return OPERATOR_LABELS[operator] ?? operator;
}
