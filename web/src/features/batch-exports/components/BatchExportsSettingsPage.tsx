import Header from "@/src/components/layouts/header";
import { Alert, AlertDescription, AlertTitle } from "@/src/components/ui/alert";
import { BatchExportsTable } from "@/src/features/batch-exports/components/BatchExportsTable";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { SettingsTableCard } from "@/src/components/layouts/settings-table-card";

export function BatchExportsSettingsPage(props: { projectId: string }) {
  const hasAccess = useHasProjectAccess({
    projectId: props.projectId,
    scope: "batchExports:read",
  });

  return (
    <>
      <Header title="Exports" />
      <p className="mb-4 text-sm">
        Exports are prepared on demand from Doris. Files smaller than 1 GB can
        be downloaded directly in the browser. Larger exports remain available
        through the signed download API for a limited time and should be fetched
        outside the browser.
      </p>
      {hasAccess ? (
        <SettingsTableCard>
          <BatchExportsTable projectId={props.projectId} />
        </SettingsTableCard>
      ) : (
        <Alert>
          <AlertTitle>Access Denied</AlertTitle>
          <AlertDescription>
            You do not have permission to view batch exports.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
