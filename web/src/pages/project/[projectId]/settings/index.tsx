import Header from "@/src/components/layouts/header";
import { ApiKeyList } from "@/src/features/public-api/components/ApiKeyList";
import { DeleteProjectButton } from "@/src/features/projects/components/DeleteProjectButton";
import { HostNameProject } from "@/src/features/projects/components/HostNameProject";
import RenameProject from "@/src/features/projects/components/RenameProject";
import { Button } from "@/src/components/ui/button";
import Link from "next/link";
import { LlmApiKeyList } from "@/src/features/public-api/components/LLMApiKeyList";
import { PagedSettingsContainer } from "@/src/components/PagedSettingsContainer";
import { useQueryProject } from "@/src/features/projects/hooks";
import { MembershipInvitesPage } from "@/src/features/rbac/components/MembershipInvitesPage";
import { MembersTable } from "@/src/features/rbac/components/MembersTable";
import { JSONView } from "@/src/components/ui/CodeJsonViewer";
import { PostHogLogo } from "@/src/components/PosthogLogo";
import { MixpanelLogo } from "@/src/components/MixpanelLogo";
import { Card } from "@/src/components/ui/card";
import { TransferProjectButton } from "@/src/features/projects/components/TransferProjectButton";
import { useHasEntitlement, usePlan } from "@/src/features/entitlements/hooks";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { useRouter } from "next/router";
import { SettingsDangerZone } from "@/src/components/SettingsDangerZone";
import { ActionButton } from "@/src/components/ActionButton";
import { BatchExportsSettingsPage } from "@/src/features/batch-exports/components/BatchExportsSettingsPage";
import { BatchActionsSettingsPage } from "@/src/features/batch-actions/components/BatchActionsSettingsPage";
import { AuditLogsSettingsPage } from "@/src/features/audit-logs/AuditLogsSettingsPage";
import { ModelsSettings } from "@/src/features/models/components/ModelSettings";
import ConfigureRetention from "@/src/features/projects/components/ConfigureRetention";
import ContainerPage from "@/src/components/layouts/container-page";
import ProtectedLabelsSettings from "@/src/features/prompts/components/ProtectedLabelsSettings";
import { Slack } from "lucide-react";
import { ScoreConfigSettings } from "@/src/features/score-configs/components/ScoreConfigSettings";
import { env } from "@/src/env.mjs";
import { NotificationSettings } from "@/src/features/notifications/components/NotificationSettings";

import { useTranslation } from "react-i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";
import { type TFunction } from "i18next";
type ProjectSettingsPage = {
  title: string;
  slug: string;
  show?: boolean | (() => boolean);
  cmdKKeywords?: string[];
} & ({ content: React.ReactNode } | { href: string });

export function useProjectSettingsPages(): ProjectSettingsPage[] {
  const { t } = useTranslation();
  const router = useRouter();
  const { project, organization } = useQueryProject();
  // Data retention is gated to self-hosted enterprise only (license litefuse_ee_).
  // Cloud org plans (incl. pro) and self-hosted free must not see it.
  const showRetentionSettings = usePlan() === "self-hosted:enterprise";
  const projectId =
    typeof router.query.projectId === "string"
      ? router.query.projectId
      : undefined;
  // This release only ships admin-api: hide the audit-logs / prompt-protected-labels entry points for now
  const showProtectedLabelsSettings = false;
  const showAuditLogsSettings = false;
  const showExportsSettings = useHasProjectAccess({
    projectId,
    scope: "batchExports:read",
  });
  const showBatchActionsSettings = useHasProjectAccess({
    projectId,
    scope: "datasets:CUD",
  });
  const showIntegrationsSettings = useHasProjectAccess({
    projectId,
    scope: "integrations:CRUD",
  });

  if (!project || !organization || !router.query.projectId) {
    return [];
  }

  return getProjectSettingsPages({
    project,
    organization,
    showRetentionSettings,
    showLLMConnectionsSettings: true,
    showProtectedLabelsSettings,
    showAuditLogsSettings,
    showExportsSettings,
    showBatchActionsSettings,
    showIntegrationsSettings,
    t,
  });
}

export const getProjectSettingsPages = ({
  project,
  organization,
  showRetentionSettings,
  showLLMConnectionsSettings,
  showProtectedLabelsSettings,
  showAuditLogsSettings,
  showExportsSettings,
  showBatchActionsSettings,
  showIntegrationsSettings,
  t,
}: {
  project: { id: string; name: string; metadata: Record<string, unknown> };
  organization: { id: string; name: string; metadata: Record<string, unknown> };
  showRetentionSettings: boolean;
  showLLMConnectionsSettings: boolean;
  showProtectedLabelsSettings: boolean;
  showAuditLogsSettings: boolean;
  showExportsSettings: boolean;
  showBatchActionsSettings: boolean;
  showIntegrationsSettings: boolean;
  t: TFunction;
}): ProjectSettingsPage[] => [
  {
    title: i18nKey("General"),
    slug: "index",
    cmdKKeywords: ["name", "id", "delete", "transfer", "ownership"],
    content: (
      <div className="flex flex-col gap-6">
        <HostNameProject />
        <RenameProject />
        {showRetentionSettings && <ConfigureRetention />}
        <div>
          <Header title={t("Debug Information")} />
          <JSONView
            title={t("Metadata")}
            json={{
              project: {
                name: project.name,
                id: project.id,
                ...project.metadata,
              },
              org: {
                name: organization.name,
                id: organization.id,
                ...organization.metadata,
              },
              ...(env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION && {
                cloudRegion: env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION,
              }),
            }}
          />
        </div>
        <SettingsDangerZone
          items={[
            {
              title: i18nKey("Transfer ownership"),
              description: i18nKey(
                "Transfer this project to another organization where you have the ability to create projects.",
              ),
              button: <TransferProjectButton />,
            },
            {
              title: i18nKey("Delete this project"),
              description: i18nKey(
                "Once you delete a project, there is no going back. Please be certain.",
              ),
              button: <DeleteProjectButton />,
            },
          ]}
        />
      </div>
    ),
  },
  {
    title: i18nKey("API Keys"),
    slug: "api-keys",
    cmdKKeywords: ["auth", "public key", "secret key"],
    content: (
      <div className="flex flex-col gap-6">
        <ApiKeyList entityId={project.id} scope="project" />
      </div>
    ),
  },
  {
    title: i18nKey("LLM Connections"),
    slug: "llm-connections",
    cmdKKeywords: [
      "llm",
      "provider",
      "openai",
      "anthropic",
      "azure",
      "playground",
      "evaluation",
      "endpoint",
      "api",
    ],
    content: (
      <div className="flex flex-col gap-6">
        <LlmApiKeyList projectId={project.id} />
      </div>
    ),
    show: showLLMConnectionsSettings,
  },
  {
    title: i18nKey("Model Definitions"),
    slug: "models",
    cmdKKeywords: ["cost", "token"],
    content: <ModelsSettings projectId={project.id} />,
  },
  {
    title: i18nKey("Protected Prompt Labels"),
    slug: "protected-prompt-labels",
    cmdKKeywords: ["prompt", "label", "protect", "lock"],
    content: <ProtectedLabelsSettings projectId={project.id} />,
    show: showProtectedLabelsSettings,
  },
  {
    title: i18nKey("Scores Configs"),
    slug: "scores",
    cmdKKeywords: ["config"],
    content: <ScoreConfigSettings projectId={project.id} />,
  },
  {
    title: i18nKey("Members"),
    slug: "members",
    cmdKKeywords: ["invite", "user"],
    content: (
      <div>
        <Header title={t("Project Members")} />
        <MembersTable
          orgId={organization.id}
          project={{ id: project.id, name: project.name }}
          showSettingsCard
        />
        <div>
          <MembershipInvitesPage
            orgId={organization.id}
            projectId={project.id}
          />
        </div>
      </div>
    ),
  },
  {
    title: i18nKey("Integrations"),
    slug: "integrations",
    cmdKKeywords: ["posthog", "mixpanel", "analytics"],
    content: <Integrations projectId={project.id} />,
    show: showIntegrationsSettings,
  },
  {
    title: i18nKey("Exports"),
    slug: "exports",
    cmdKKeywords: ["csv", "download", "json", "batch"],
    content: <BatchExportsSettingsPage projectId={project.id} />,
    show: showExportsSettings,
  },
  {
    title: i18nKey("Batch Actions"),
    slug: "batch-actions",
    cmdKKeywords: ["bulk", "batch", "action", "dataset", "delete"],
    content: <BatchActionsSettingsPage projectId={project.id} />,
    show: showBatchActionsSettings,
  },
  {
    title: i18nKey("Audit Logs"),
    slug: "audit-logs",
    cmdKKeywords: ["trail"],
    content: <AuditLogsSettingsPage projectId={project.id} />,
    show: showAuditLogsSettings,
  },
  {
    title: i18nKey("Notifications"),
    slug: "notifications",
    cmdKKeywords: ["inbox", "email", "mention", "alert"],
    content: <NotificationSettings />,
  },
  {
    title: i18nKey("Organization Settings"),
    slug: "organization",
    href: `/organization/${organization.id}/settings`,
  },
];

export default function SettingsPage() {
  const { t } = useTranslation();
  const { project, organization } = useQueryProject();
  const router = useRouter();
  const pages = useProjectSettingsPages();

  if (!project || !organization) return null;

  return (
    <ContainerPage
      headerProps={{
        title: t("Project Settings"),
      }}
    >
      <PagedSettingsContainer
        activeSlug={router.query.page as string | undefined}
        pages={pages}
      />
    </ContainerPage>
  );
}

const Integrations = (props: { projectId: string }) => {
  const { t } = useTranslation();
  const hasAccess = useHasProjectAccess({
    projectId: props.projectId,
    scope: "integrations:CRUD",
  });

  const allowBlobStorageIntegration = useHasEntitlement(
    "scheduled-blob-exports",
  );

  return (
    <div>
      <Header title={t("Integrations")} />
      <div className="space-y-6">
        <Card className="p-3">
          {}
          <PostHogLogo className="text-foreground mb-4 w-40" />
          <p className="text-primary mb-4 text-sm">
            {t(
              "We have teamed up with PostHog (OSS product analytics) to make Litefuse Events/Metrics available in your Posthog Dashboards.",
            )}
          </p>
          <div className="flex items-center gap-2">
            <ActionButton
              variant="secondary"
              hasAccess={hasAccess}
              href={`/project/${props.projectId}/settings/integrations/posthog`}
            >
              {t("Configure")}
            </ActionButton>
            <Button asChild variant="ghost">
              <Link
                href="https://litefuse.ai/integrations/analytics/posthog"
                target="_blank"
              >
                {t("Integration Docs ↗")}
              </Link>
            </Button>
          </div>
        </Card>

        <Card className="p-3" hidden={true}>
          <MixpanelLogo className="text-foreground mb-4 w-20" />
          <p className="text-primary mb-4 text-sm">
            {t(
              "Integrate with Mixpanel to sync your Litefuse traces, generations, and scores for advanced product analytics and insights.",
            )}
          </p>
          <div className="flex items-center gap-2">
            <ActionButton
              variant="secondary"
              hasAccess={hasAccess}
              href={`/project/${props.projectId}/settings/integrations/mixpanel`}
            >
              {t("Configure")}
            </ActionButton>
            <Button asChild variant="ghost">
              <Link
                href="https://litefuse.ai/integrations/analytics/mixpanel"
                target="_blank"
              >
                {t("Integration Docs ↗")}
              </Link>
            </Button>
          </div>
        </Card>

        <Card className="p-3">
          <span className="font-semibold">{t("Blob Storage")}</span>
          <p className="text-primary mb-4 text-sm">
            {t(
              "Configure scheduled exports of your trace data to S3 compatible storages or Azure Blob Storage. Set up a scheduled export to your own storage for data analysis or backup purposes.",
            )}
          </p>
          <div className="flex items-center gap-2">
            <ActionButton
              variant="secondary"
              hasAccess={hasAccess}
              hasEntitlement={allowBlobStorageIntegration}
              href={`/project/${props.projectId}/settings/integrations/blobstorage`}
            >
              {t("Configure")}
            </ActionButton>
            <Button asChild variant="ghost">
              <Link
                href="https://litefuse.ai/docs/query-traces#blob-storage"
                target="_blank"
              >
                {t("Integration Docs ↗")}
              </Link>
            </Button>
          </div>
        </Card>

        <Card className="p-3" hidden={true}>
          <div className="mb-4 flex items-center gap-2">
            <Slack className="text-foreground h-5 w-5" />
            <span className="font-semibold">{t("Slack")}</span>
          </div>
          <p className="text-primary mb-4 text-sm">
            {t(
              "Connect a Slack workspace and create channel automations to receive Litefuse alerts natively in Slack.",
            )}
          </p>
          <div className="flex items-center gap-2">
            <ActionButton
              variant="secondary"
              hasAccess={hasAccess}
              href={`/project/${props.projectId}/settings/integrations/slack`}
            >
              {t("Configure")}
            </ActionButton>
          </div>
        </Card>
      </div>
    </div>
  );
};
