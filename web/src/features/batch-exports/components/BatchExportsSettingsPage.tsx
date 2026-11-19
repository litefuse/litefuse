import Header from "@/src/components/layouts/header";
import { Alert, AlertDescription, AlertTitle } from "@/src/components/ui/alert";
import { BatchExportsTable } from "@/src/features/batch-exports/components/BatchExportsTable";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { SettingsTableCard } from "@/src/components/layouts/settings-table-card";

import { useTranslation } from "react-i18next";
export function BatchExportsSettingsPage(props: { projectId: string }) {
  const { t } = useTranslation();
  const hasAccess = useHasProjectAccess({
    projectId: props.projectId,
    scope: "batchExports:read",
  });

  return (
    <>
      <Header title={t("Exports")} />
      <p className="mb-4 text-sm">
        {t(
          "Export large datasets in your preferred format via the export buttons across Litefuse. Exports are processed asynchronously and remain available for download for one hour. You will receive an email notification once your export is ready.",
        )}
      </p>
      {hasAccess ? (
        <SettingsTableCard>
          <BatchExportsTable projectId={props.projectId} />
        </SettingsTableCard>
      ) : (
        <Alert>
          <AlertTitle>{t("Access Denied")}</AlertTitle>
          <AlertDescription>
            {t("You do not have permission to view batch exports.")}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
