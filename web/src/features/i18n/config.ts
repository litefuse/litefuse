/**
 * Locale configuration shared by server (request resolution, tRPC) and client
 * (provider, switcher). Keep this module free of React and Node-only imports.
 */

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

/** Same cookie name Next.js uses for its own locale detection. */
export const LOCALE_COOKIE_NAME = "NEXT_LOCALE";

export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Native-language labels, intentionally not translated. */
export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

export function isAppLocale(value: unknown): value is AppLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Map a BCP-47 language tag (any case, any region/script subtags) onto a
 * supported locale. Returns undefined when nothing we ship is a sensible match,
 * e.g. Traditional Chinese variants are not mapped onto zh-CN.
 */
export function matchLocaleTag(
  tag: string | undefined | null,
): AppLocale | undefined {
  if (!tag) return undefined;
  const normalized = tag.trim().toLowerCase();
  if (!normalized) return undefined;

  const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === normalized);
  if (exact) return exact;

  const [primary, ...subtags] = normalized.split("-");
  if (primary === "zh") {
    const traditional = subtags.some((s) =>
      ["hant", "tw", "hk", "mo"].includes(s),
    );
    return traditional ? undefined : "zh-CN";
  }
  return SUPPORTED_LOCALES.find(
    (l) => l.toLowerCase().split("-")[0] === primary,
  );
}

/**
 * Parse LITEFUSE_I18N_LOCALES (comma separated). The default locale is always
 * enabled and listed first; unknown entries are ignored.
 */
export function parseEnabledLocales(
  raw: string | undefined | null,
): AppLocale[] {
  const parsed = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isAppLocale);
  return Array.from(new Set<AppLocale>([DEFAULT_LOCALE, ...parsed]));
}

/** Pick the best enabled locale from an Accept-Language header. */
export function pickFromAcceptLanguage(
  header: string | undefined | null,
  enabledLocales: readonly AppLocale[],
): AppLocale | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q ? Number.parseFloat(q.slice(2)) : 1;
      return {
        tag: tag?.trim() ?? "",
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((entry) => entry.tag && entry.tag !== "*" && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  for (const entry of ranked) {
    const match = matchLocaleTag(entry.tag);
    if (match && enabledLocales.includes(match)) return match;
  }
  return undefined;
}

/**
 * Resolution order: account preference > device cookie > Accept-Language >
 * default. Every candidate must be in `enabledLocales`.
 */
export function resolveLocale(params: {
  enabledLocales: readonly AppLocale[];
  userLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}): AppLocale {
  const { enabledLocales, userLocale, cookieLocale, acceptLanguage } = params;
  for (const candidate of [userLocale, cookieLocale]) {
    if (isAppLocale(candidate) && enabledLocales.includes(candidate)) {
      return candidate;
    }
  }
  return (
    pickFromAcceptLanguage(acceptLanguage, enabledLocales) ?? DEFAULT_LOCALE
  );
}

/** Extract the locale cookie value from a raw Cookie header / document.cookie. */
export function readLocaleCookie(
  cookieHeader: string | undefined | null,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== LOCALE_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function serializeLocaleCookie(locale: AppLocale): string {
  return `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}
