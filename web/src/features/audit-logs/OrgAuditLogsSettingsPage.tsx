import Header from "@/src/components/layouts/header";
import { Alert, AlertDescription, AlertTitle } from "@/src/components/ui/alert";
import { AuditLogsTable } from "@/src/features/audit-logs/AuditLogsTable";
import { useHasEntitlement } from "@/src/features/entitlements/hooks";
import { useHasOrganizationAccess } from "@/src/features/rbac/utils/checkOrganizationAccess";

import { useTranslation } from "react-i18next";
export function OrgAuditLogsSettingsPage({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const canReadAuditLogs = useHasOrganizationAccess({
    organizationId: orgId,
    scope: "auditLogs:read",
  });
  const auditLogsEntitled = useHasEntitlement("audit-logs");

  // Shown instead of the table when the plan or the RBAC scope is missing.
  const restricted = !auditLogsEntitled ? (
    <p className="text-muted-foreground text-sm">
      {t(
        "Audit logs are an Enterprise feature. Upgrade your plan to track all changes made to your organization.",
      )}
    </p>
  ) : !canReadAuditLogs ? (
    <Alert>
      <AlertTitle>{t("Access restricted")}</AlertTitle>
      <AlertDescription>
        {t("Ask an organization administrator to grant you access.")}
      </AlertDescription>
    </Alert>
  ) : null;

  return (
    <>
      <Header title={t("Organization Audit Log")} />
      <p className="text-muted-foreground mb-2 text-sm">
        {t(
          "Track who changed what in your organization and when. Monitor organization settings, project creation/deletion, and membership changes over time.",
        )}
      </p>
      {restricted ?? <AuditLogsTable scope="organization" orgId={orgId} />}
    </>
  );
}
