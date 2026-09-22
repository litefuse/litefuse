import Header from "@/src/components/layouts/header";
import { Alert, AlertDescription, AlertTitle } from "@/src/components/ui/alert";
import { AuditLogsTable } from "@/src/features/audit-logs/AuditLogsTable";
import { useHasEntitlement } from "@/src/features/entitlements/hooks";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";

import { useTranslation } from "react-i18next";
export function AuditLogsSettingsPage(props: { projectId: string }) {
  const { t } = useTranslation();
  const hasAccess = useHasProjectAccess({
    projectId: props.projectId,
    scope: "auditLogs:read",
  });
  const hasEntitlement = useHasEntitlement("audit-logs");

  const body = !hasEntitlement ? (
    <p className="text-muted-foreground text-sm">
      {t(
        "Audit logs are an Enterprise feature. Upgrade your plan to track all changes made to your project.",
      )}
    </p>
  ) : !hasAccess ? (
    <Alert>
      <AlertTitle>{t("Access Denied")}</AlertTitle>
      <AlertDescription>
        {t("Contact your project administrator to request access.")}
      </AlertDescription>
    </Alert>
  ) : (
    <AuditLogsTable scope="project" projectId={props.projectId} />
  );

  return (
    <>
      <Header title={t("Audit Logs")} />
      <p className="text-muted-foreground mb-2 text-sm">
        {t(
          "Track who changed what in your project and when. Monitor settings, configurations, and data changes over time.",
        )}
      </p>
      {body}
    </>
  );
}
