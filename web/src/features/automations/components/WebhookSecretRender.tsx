import React from "react";
import { CodeView } from "@/src/components/ui/CodeJsonViewer";

import { useTranslation } from "react-i18next";
export const WebhookSecretRender = ({
  webhookSecret,
}: {
  webhookSecret: string;
}) => {
  const { t } = useTranslation();
  return (
    <>
      <div className="mb-4">
        <div className="text-md font-semibold">{t("Webhook Secret")}</div>
        <div className="my-2 text-sm">
          {t(
            "This secret can only be viewed once. You can regenerate it in the automation settings if needed. Use this secret to verify webhook signatures in your endpoint.",
          )}
        </div>
        <CodeView content={webhookSecret} defaultCollapsed={false} />
      </div>
    </>
  );
};
