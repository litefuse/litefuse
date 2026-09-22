import type { IncomingMessage } from "http";
import { env } from "@/src/env.mjs";
import {
  DEFAULT_LOCALE,
  parseEnabledLocales,
  readLocaleCookie,
  resolveLocale,
  type AppLocale,
} from "@/src/features/i18n/config";
import type { I18nAppProps } from "@/src/features/i18n/I18nProvider";

/**
 * Server-side locale resolution for the first render (App and Document).
 * The session is deliberately not consulted here: fetching it per request is
 * expensive and the provider re-syncs to the account preference on the client.
 */
export function resolveRequestI18n(
  req: IncomingMessage | undefined,
): I18nAppProps {
  if (!req) {
    return { locale: DEFAULT_LOCALE, enabledLocales: [DEFAULT_LOCALE] };
  }
  // Server-only env var: accessing it on the client throws, hence the guard
  // through `req` above (it is only defined during server rendering).
  const enabledLocales = parseEnabledLocales(env.LITEFUSE_I18N_LOCALES);
  const locale: AppLocale = resolveLocale({
    enabledLocales,
    cookieLocale: readLocaleCookie(req.headers.cookie),
    acceptLanguage: req.headers["accept-language"],
  });
  return { locale, enabledLocales };
}
