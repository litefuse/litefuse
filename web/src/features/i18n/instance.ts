import i18next, { type i18n } from "i18next";
import zhCN from "@/src/features/i18n/locales/zh-CN.json";
import { DEFAULT_LOCALE, type AppLocale } from "@/src/features/i18n/config";

const resources = {
  "zh-CN": { translation: zhCN },
};

/**
 * One i18next instance per provider (per request on the server) so that
 * concurrent server renders with different locales never share language state.
 * Resources are bundled and init is synchronous, which SSR requires.
 */
export function createI18nInstance(locale: AppLocale): i18n {
  const instance = i18next.createInstance({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    resources,
    // Keys are the English source text. Disable the separators so "." and ":"
    // inside a sentence are not interpreted as nesting / namespace markers.
    keySeparator: false,
    nsSeparator: false,
    // React already escapes interpolated values.
    interpolation: { escapeValue: false },
    initAsync: false,
    // An empty value in a locale file falls back to the English key.
    returnEmptyString: false,
    react: { useSuspense: false },
  });
  void instance.init();
  return instance;
}
