import Header from "@/src/components/layouts/header";
import { Alert, AlertDescription, AlertTitle } from "@/src/components/ui/alert";
import { AuditLogsTable } from "@/src/features/audit-logs/AuditLogsTable";
import { useHasEntitlement } from "@/src/features/entitlements/hooks";
import { useHasOrganizationAccess } from "@/src/features/rbac/utils/checkOrganizationAccess";

import { useTranslation } from "react-i18next";
export function OrgAuditLogsSettingsPage(props: { orgId: string }) {
  const { t } = useTranslation();
  const hasAccess = useHasOrganizationAccess({
    organizationId: props.orgId,
    scope: "auditLogs:read",
  });
  const hasEntitlement = useHasEntitlement("audit-logs");

  const body = !hasEntitlement ? (
    <p className="text-muted-foreground text-sm">
      {t(
        "Audit logs are an Enterprise feature. Upgrade your plan to track all changes made to your organization.",
      )}
    </p>
  ) : !hasAccess ? (
    <Alert>
      <AlertTitle>{t("Access Denied")}</AlertTitle>
      <AlertDescription>
        {t("Contact your organization administrator to request access.")}
      </AlertDescription>
    </Alert>
  ) : (
    <AuditLogsTable scope="organization" orgId={props.orgId} />
  );

  return (
    <>
      <Header title={t("Organization Audit Logs")} />
      <p className="text-muted-foreground mb-2 text-sm">
        {t(
          "Track who changed what in your organization and when. Monitor organization settings, project creation/deletion, and membership changes over time.",
        )}
      </p>
      {body}
    </>
  );
}
