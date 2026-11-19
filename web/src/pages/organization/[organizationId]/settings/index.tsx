import { PagedSettingsContainer } from "@/src/components/PagedSettingsContainer";
import Header from "@/src/components/layouts/header";
import { MembershipInvitesPage } from "@/src/features/rbac/components/MembershipInvitesPage";
import { MembersTable } from "@/src/features/rbac/components/MembersTable";
import { JSONView } from "@/src/components/ui/CodeJsonViewer";
import RenameOrganization from "@/src/features/organizations/components/RenameOrganization";
import { useQueryOrganization } from "@/src/features/organizations/hooks";
import { useRouter } from "next/router";
import { SettingsDangerZone } from "@/src/components/SettingsDangerZone";
import { DeleteOrganizationButton } from "@/src/features/organizations/components/DeleteOrganizationButton";
import { useHasEntitlement } from "@/src/features/entitlements/hooks";
import ContainerPage from "@/src/components/layouts/container-page";
import { useQueryProjectOrOrganization } from "@/src/features/projects/hooks";
import { ApiKeyList } from "@/src/features/public-api/components/ApiKeyList";
import { env } from "@/src/env.mjs";
import { BillingSettings } from "@/src/features/billing/components/BillingSettings";
import { useHasOrganizationAccess } from "@/src/features/rbac/utils/checkOrganizationAccess";
import { OrgAuditLogsSettingsPage } from "@/src/features/audit-logs/OrgAuditLogsSettingsPage";

import { useTranslation } from "react-i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";
import { type TFunction } from "i18next";
// EE features removed from OSS build:
//  - SSOSettings (multi-tenant SSO config)

type OrganizationSettingsPage = {
  title: string;
  slug: string;
  show?: boolean | (() => boolean);
  cmdKKeywords?: string[];
} & ({ content: React.ReactNode } | { href: string });

export function useOrganizationSettingsPages(): OrganizationSettingsPage[] {
  const { t } = useTranslation();
  const { organization } = useQueryProjectOrOrganization();
  const showOrgApiKeySettings = useHasEntitlement("admin-api");
  const hasBillingAccess = useHasOrganizationAccess({
    organizationId: organization?.id,
    scope: "langfuseCloudBilling:CRUD",
  });
  const showBillingSettings =
    Boolean(env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION) && hasBillingAccess;
  // This release only ships admin-api: hide the audit-logs entry point for now
  const showAuditLogsSettings = false;

  if (!organization) return [];

  return getOrganizationSettingsPages({
    organization,
    showOrgApiKeySettings,
    showBillingSettings,
    showAuditLogsSettings,
    t,
  });
}

export const getOrganizationSettingsPages = ({
  organization,
  showOrgApiKeySettings,
  showBillingSettings,
  showAuditLogsSettings,
  t,
}: {
  organization: { id: string; name: string; metadata: Record<string, unknown> };
  showOrgApiKeySettings: boolean;
  showBillingSettings: boolean;
  showAuditLogsSettings: boolean;
  t: TFunction;
}): OrganizationSettingsPage[] => [
  {
    title: i18nKey("General"),
    slug: "index",
    cmdKKeywords: ["name", "id", "delete"],
    content: (
      <div className="flex flex-col gap-6">
        <RenameOrganization />
        <div>
          <Header title={t("Debug Information")} />
          <JSONView
            title={t("Metadata")}
            json={{
              name: organization.name,
              id: organization.id,
              ...organization.metadata,
              ...(env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION && {
                cloudRegion: env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION,
              }),
            }}
          />
        </div>
        <SettingsDangerZone
          items={[
            {
              title: i18nKey("Delete this organization"),
              description: i18nKey(
                "Once you delete an organization, there is no going back. Please be certain.",
              ),
              button: <DeleteOrganizationButton />,
            },
          ]}
        />
      </div>
    ),
  },
  {
    title: i18nKey("API Keys"),
    slug: "api-keys",
    content: (
      <div className="flex flex-col gap-6">
        <ApiKeyList entityId={organization.id} scope="organization" />
      </div>
    ),
    show: showOrgApiKeySettings,
  },
  {
    title: i18nKey("Billing"),
    slug: "billing",
    cmdKKeywords: ["plan", "pro", "stripe", "subscription"],
    content: <BillingSettings orgId={organization.id} />,
    show: showBillingSettings,
  },
  {
    title: i18nKey("Members"),
    slug: "members",
    cmdKKeywords: ["invite", "user", "rbac"],
    content: (
      <div className="flex flex-col gap-6">
        <div>
          <Header title={t("Organization Members")} />
          <MembersTable orgId={organization.id} />
        </div>
        <div>
          <MembershipInvitesPage orgId={organization.id} />
        </div>
      </div>
    ),
  },
  {
    title: i18nKey("Audit Logs"),
    slug: "audit-logs",
    cmdKKeywords: ["trail"],
    content: <OrgAuditLogsSettingsPage orgId={organization.id} />,
    show: showAuditLogsSettings,
  },
  {
    title: i18nKey("Projects"),
    slug: "projects",
    href: `/organization/${organization.id}`,
  },
];

const OrgSettingsPage = () => {
  const { t } = useTranslation();
  const organization = useQueryOrganization();
  const router = useRouter();
  const { page } = router.query;
  const pages = useOrganizationSettingsPages();

  if (!organization) return null;

  return (
    <ContainerPage
      headerProps={{
        title: t("Organization Settings"),
      }}
    >
      <PagedSettingsContainer
        activeSlug={page as string | undefined}
        pages={pages}
      />
    </ContainerPage>
  );
};

export default OrgSettingsPage;
