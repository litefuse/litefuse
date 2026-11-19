import { Card } from "@/src/components/ui/card";
import { CodeView } from "@/src/components/ui/CodeJsonViewer";
import Header from "@/src/components/layouts/header";
import { env } from "@/src/env.mjs";
import { useUiCustomization } from "@/src/features/ui-customization/useUiCustomization";

import { useTranslation } from "react-i18next";
export function HostNameProject() {
  const { t } = useTranslation();
  const uiCustomization = useUiCustomization();
  return (
    <div>
      <Header title={t("Host Name")} />
      <Card className="mb-4 p-3">
        <div className="">
          <div className="mb-2 text-sm">
            {t("When connecting to Litefuse, use this hostname / baseurl.")}
          </div>
          <CodeView
            content={`${uiCustomization?.hostname ?? window.origin}${env.NEXT_PUBLIC_BASE_PATH ?? ""}`}
          />
        </div>
      </Card>
    </div>
  );
}
