import { AlertCircle } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/src/components/ui/alert";

import { useTranslation } from "react-i18next";
/**
 * Placeholder screen for pages whose RBAC scope the current user does not
 * hold. It only explains the restriction; the caller decides whether to render
 * it at all.
 */
export function SupportOrUpgradePage() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full w-full p-6">
      <div className="m-auto w-full max-w-md">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("Access Restricted")}</AlertTitle>
          <AlertDescription>
            <p className="mb-2">
              {t("This feature requires additional permissions")}
            </p>
            <p>
              {t(
                "Contact your system/project administrator for access. Need help? Reach out to support.",
              )}
            </p>
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}
