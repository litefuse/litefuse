/**
 * Loading layout variant
 * Shown during session loading and authentication redirects
 */

import { Spinner } from "@/src/components/layouts/spinner";
import { useTranslation } from "react-i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";

type LoadingLayoutProps = {
  /** An i18n key, not display text: Spinner renders what it is handed. */
  message?: string;
};

export function LoadingLayout({
  message = i18nKey("Loading"),
}: LoadingLayoutProps) {
  const { t } = useTranslation();
  return <Spinner message={t(message)} />;
}
