import Header from "@/src/components/layouts/header";
import { Alert, AlertDescription, AlertTitle } from "@/src/components/ui/alert";
import { AuditLogsTable } from "@/src/features/audit-logs/AuditLogsTable";
import { useHasEntitlement } from "@/src/features/entitlements/hooks";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";

import { useTranslation } from "react-i18next";
export function AuditLogsSettingsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const canReadAuditLogs = useHasProjectAccess({
    projectId,
    scope: "auditLogs:read",
  });
  const auditLogsEntitled = useHasEntitlement("audit-logs");

  // Shown instead of the table when the plan or the RBAC scope is missing.
  const restricted = !auditLogsEntitled ? (
    <p className="text-muted-foreground text-sm">
      {t(
        "Audit logs are an Enterprise feature. Upgrade your plan to track all changes made to your project.",
      )}
    </p>
  ) : !canReadAuditLogs ? (
    <Alert>
      <AlertTitle>{t("Access restricted")}</AlertTitle>
      <AlertDescription>
        {t("Ask a project administrator to grant you access.")}
      </AlertDescription>
    </Alert>
  ) : null;

  return (
    <>
      <Header title={t("Project Audit Log")} />
      <p className="text-muted-foreground mb-2 text-sm">
        {t(
          "Track who changed what in your project and when. Monitor settings, configurations, and data changes over time.",
        )}
      </p>
      {restricted ?? <AuditLogsTable scope="project" projectId={projectId} />}
    </>
  );
}
