// @ts-nocheck
/**
 * Shim for react-i18next
 *
 * Provides a minimal `useTranslation` hook.  All translation keys are
 * returned as-is (English passthrough).  Replace with a real i18n
 * library if multi-language support is needed in the future.
 */

export function useTranslation(_ns?: string) {
  function t(key: string, options?: any): string;
  function t(strings: TemplateStringsArray, ...values: any[]): string;
  function t(
    keyOrStrings: string | TemplateStringsArray,
    ...args: any[]
  ): string {
    if (typeof keyOrStrings === "string") {
      if (args[0]?.defaultValue) return String(args[0].defaultValue);
      return keyOrStrings;
    }
    // Tagged template: t`key`
    return String(keyOrStrings[0] ?? "");
  }

  return { t, i18n: { language: "en", changeLanguage: async () => {} } };
}

export function Trans({ children }: { children?: React.ReactNode }): any {
  return children ?? null;
}

import React from "react";
export function I18nextProvider({ children }: { children?: React.ReactNode }) {
  return React.createElement(React.Fragment, null, children);
}

export function initReactI18next(_plugin: any) {
  return _plugin;
}
