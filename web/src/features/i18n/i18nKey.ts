/**
 * Marks an English string in static data (route tables, label maps, enums) as
 * a translation key. It is the identity at runtime; the component that renders
 * the value must call `t(value)`. The extractor (`i18next.config.ts`) treats
 * `i18nKey(...)` like `t(...)`, so the key is tracked in the locale files.
 */
export const i18nKey = (key: string): string => key;
