import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE } from "@/src/features/i18n/config";

/**
 * Client tests render components that call useTranslation() without mounting
 * I18nProvider. Without an initialised default instance, i18next returns the
 * key verbatim and never interpolates, so "{{count}} units" reaches the DOM.
 *
 * Initialising the default instance in English makes t() behave exactly as it
 * does for an English user: the key is the source text, so no resources are
 * needed and assertions can be written against the English copy.
 */
void i18next.use(initReactI18next).init({
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  resources: { [DEFAULT_LOCALE]: { translation: {} } },
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  initAsync: false,
  returnEmptyString: false,
  react: { useSuspense: false },
});
