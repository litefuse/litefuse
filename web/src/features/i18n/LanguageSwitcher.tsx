import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { api } from "@/src/utils/api";
import { cn } from "@/src/utils/tailwind";
import { isAppLocale, LOCALE_LABELS } from "@/src/features/i18n/config";
import { useLocale } from "@/src/features/i18n/I18nProvider";

/**
 * Renders nothing unless the deployment enables more than one locale.
 * Persists to the device cookie always and to the account when signed in.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { locale, enabledLocales, isMultiLocale, setLocale } = useLocale();
  const session = useSession();
  const updateLocale = api.userAccount.updateLocale.useMutation({
    onSuccess: () => session.update(),
  });

  if (!isMultiLocale) return null;

  const onValueChange = (value: string) => {
    if (!isAppLocale(value) || value === locale) return;
    setLocale(value);
    if (session.data?.user) {
      updateLocale.mutate({ locale: value });
    }
  };

  return (
    <Select value={locale} onValueChange={onValueChange}>
      <SelectTrigger
        className={cn("w-[180px]", className)}
        aria-label={t("Language")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {enabledLocales.map((l) => (
          <SelectItem key={l} value={l}>
            {LOCALE_LABELS[l]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
