import { useTranslation } from "react-i18next";
import Header from "@/src/components/layouts/header";
import { Card } from "@/src/components/ui/card";
import { LanguageSwitcher } from "@/src/features/i18n/LanguageSwitcher";
import { useLocale } from "@/src/features/i18n/I18nProvider";

/** Account settings section; hidden on single-locale deployments. */
export function LanguageSettingsCard() {
  const { t } = useTranslation();
  const { isMultiLocale } = useLocale();
  if (!isMultiLocale) return null;

  return (
    <div>
      <Header title={t("Language")} />
      <Card className="p-3">
        <p className="text-primary mb-4 text-sm">
          {t("Choose the language of the Litefuse interface.")}
        </p>
        <LanguageSwitcher />
      </Card>
    </div>
  );
}
