import Header from "@/src/components/layouts/header";
import React from "react";

import { useTranslation } from "react-i18next";
export const SettingsDangerZone: React.FC<{
  items: {
    title: string;
    description: string;
    button: React.ReactNode;
  }[];
}> = ({ items }) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <Header title={t("Danger Zone")} />
      <div className="rounded-lg border">
        {items.map((item, index) => (
          <div
            key={index}
            className="flex items-center justify-between gap-4 border-b p-3 last:border-b-0"
          >
            <div>
              <h4 className="font-semibold">{t(item.title)}</h4>
              <p className="text-sm">{t(item.description)}</p>
            </div>
            {item.button}
          </div>
        ))}
      </div>
    </div>
  );
};
