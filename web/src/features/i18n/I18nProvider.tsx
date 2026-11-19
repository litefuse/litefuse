import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { I18nextProvider } from "react-i18next";
import { useSession } from "next-auth/react";
import {
  DEFAULT_LOCALE,
  isAppLocale,
  serializeLocaleCookie,
  type AppLocale,
} from "@/src/features/i18n/config";
import { createI18nInstance } from "@/src/features/i18n/instance";
import { applyRuntimeLocale } from "@/src/features/i18n/runtimeLocale";

/** Resolved on the server for the first render, see getI18nAppProps. */
export type I18nAppProps = {
  locale: AppLocale;
  enabledLocales: AppLocale[];
};

type LocaleContextValue = {
  locale: AppLocale;
  /** Locales exposed by this deployment (LITEFUSE_I18N_LOCALES). */
  enabledLocales: AppLocale[];
  /** True when a language switcher makes sense. */
  isMultiLocale: boolean;
  /** Switch the UI language and persist it in the device cookie. */
  setLocale: (locale: AppLocale) => void;
};

const fallbackContext: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  enabledLocales: [DEFAULT_LOCALE],
  isMultiLocale: false,
  setLocale: () => {},
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

const defaultInitial: I18nAppProps = {
  locale: DEFAULT_LOCALE,
  enabledLocales: [DEFAULT_LOCALE],
};

export function I18nProvider({
  initial = defaultInitial,
  children,
}: {
  /** Missing (e.g. in tests) means English only. */
  initial?: I18nAppProps;
  children: ReactNode;
}) {
  // `initial` is read once. On client-side navigations getInitialProps runs
  // again with client-side values, but the provider is mounted above the page
  // and keeps its own state.
  const [i18n] = useState(() => createI18nInstance(initial.locale));
  const [locale, setLocaleState] = useState<AppLocale>(initial.locale);
  const [enabledLocales] = useState<AppLocale[]>(initial.enabledLocales);
  const session = useSession();

  const setLocale = useCallback(
    (next: AppLocale) => {
      if (!enabledLocales.includes(next)) return;
      document.cookie = serializeLocaleCookie(next);
      void i18n.changeLanguage(next);
      setLocaleState(next);
    },
    [enabledLocales, i18n],
  );

  // The account preference wins over the device cookie once the session is
  // known (e.g. first visit from a new device). It is applied only when the
  // account value itself changes: the switcher updates the local state first
  // and persists to the account afterwards, so keying this on `locale` would
  // revert every switch until the session has been refetched.
  const userLocale = session.data?.user?.locale;
  const syncedUserLocale = useRef(userLocale);
  useEffect(() => {
    if (userLocale === syncedUserLocale.current) return;
    syncedUserLocale.current = userLocale;
    if (
      isAppLocale(userLocale) &&
      userLocale !== locale &&
      enabledLocales.includes(userLocale)
    ) {
      setLocale(userLocale);
    }
  }, [userLocale, locale, enabledLocales, setLocale]);

  // Runs during render so the first paint already formats dates in the
  // resolved locale; a useEffect would hydrate with the wrong ones.
  applyRuntimeLocale(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      enabledLocales,
      isMultiLocale: enabledLocales.length > 1,
      setLocale,
    }),
    [locale, enabledLocales, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext) ?? fallbackContext;
}
