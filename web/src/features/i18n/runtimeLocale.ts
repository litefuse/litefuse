import { setDefaultOptions } from "date-fns";
import { zhCN } from "date-fns/locale";
import { type Locale } from "date-fns";

import { DEFAULT_LOCALE, type AppLocale } from "@/src/features/i18n/config";

/**
 * The UI language, readable from plain functions.
 *
 * Date and number formatting happens in utilities and chart adapters that are
 * not React components, so they cannot read the locale from context. The
 * provider publishes it here instead, and the same call sets the date-fns
 * default: without it `format` and `formatDistanceToNow` print "Sep 14" and
 * "3 hours ago" in a Chinese UI.
 *
 * `undefined` in the date-fns map means the library's own default (en-US).
 */
const DATE_FNS_LOCALES: Partial<Record<AppLocale, Locale>> = {
  "zh-CN": zhCN,
};

/** BCP-47 tags for Intl; `AppLocale` already uses that shape. */
let activeLocale: AppLocale = DEFAULT_LOCALE;

export function applyRuntimeLocale(locale: AppLocale): void {
  activeLocale = locale;
  setDefaultOptions({ locale: DATE_FNS_LOCALES[locale] });
}

/** The tag to pass to `Intl` / `toLocaleDateString` and friends. */
export function getRuntimeLocale(): AppLocale {
  return activeLocale;
}
