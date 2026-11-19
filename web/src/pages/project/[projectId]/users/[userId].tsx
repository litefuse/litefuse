import { i18nKey } from "@/src/features/i18n/i18nKey";
import { useRouter } from "next/router";
import { api } from "@/src/utils/api";
import TracesTable from "@/src/components/table/use-cases/traces";
import ScoresTable from "@/src/components/table/use-cases/scores";
import { compactNumberFormatter, usdFormatter } from "@/src/utils/numbers";
import { StringParam, useQueryParam, withDefault } from "use-query-params";
import { DetailPageNav } from "@/src/features/navigate-detail-pages/DetailPageNav";
import SessionsTable from "@/src/components/table/use-cases/sessions";
import { cn } from "@/src/utils/tailwind";
import { Badge } from "@/src/components/ui/badge";
import { ActionButton } from "@/src/components/ActionButton";
import { LayoutDashboard } from "lucide-react";
import Page from "@/src/components/layouts/page";
import { useV4Beta } from "@/src/features/events/hooks/useV4Beta";
import { ObservationsEventsTable } from "@/src/features/events/components";

import { useTranslation } from "react-i18next";
// The tab name is the query-param value, so it stays English; the label is
// looked up here.
const tabs = ["Traces", "Sessions", "Scores"] as const;
const tabLabels: Record<(typeof tabs)[number], string> = {
  Traces: i18nKey("Traces"),
  Sessions: i18nKey("Sessions"),
  Scores: i18nKey("Scores"),
};

export default function UserPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const userId = router.query.userId as string;
  const projectId = router.query.projectId as string;
  const { isBetaEnabled } = useV4Beta();

  const userV3 = api.users.byId.useQuery(
    {
      projectId: projectId,
      userId,
    },
    { enabled: !isBetaEnabled },
  );

  const userV4 = api.users.byIdFromEvents.useQuery(
    {
      projectId: projectId,
      userId,
    },
    { enabled: isBetaEnabled },
  );

  const user = isBetaEnabled ? userV4 : userV3;

  const [currentTab, setCurrentTab] = useQueryParam(
    "tab",
    withDefault(StringParam, tabs[0]),
  );

  const renderTabContent = () => {
    switch (currentTab as (typeof tabs)[number]) {
      case "Sessions":
        return <SessionsTab userId={userId} projectId={projectId} />;
      case "Traces":
        return <TracesTab userId={userId} projectId={projectId} />;
      case "Scores":
        return <ScoresTab userId={userId} projectId={projectId} />;
      default:
        return null;
    }
  };

  const handleTabChange = async (tab: string) => {
    if (router.query.filter || router.query.orderBy) {
      const newQuery = { ...router.query };
      delete newQuery.filter;
      delete newQuery.orderBy;
      await router.replace({ query: newQuery });
    }
    setCurrentTab(tab);
  };

  return (
    <Page
      headerProps={{
        title: userId,
        breadcrumb: [{ name: t("Users"), href: `/project/${projectId}/users` }],
        itemType: "USER",
        actionButtonsRight: (
          <>
            <ActionButton
              href={`/project/${projectId}?filter=user%3Bstring%3B%3B%3D%3B${userId}`} // dashboard filter serialization
              variant="secondary"
              icon={<LayoutDashboard className="h-4 w-4" />}
            >
              {t("Dashboard")}
            </ActionButton>
            <DetailPageNav
              currentId={userId}
              path={(entry) => `/project/${projectId}/users/${entry.id}`}
              listKey="users"
            />
          </>
        ),
      }}
    >
      <>
        {user.data && (
          <div className="flex flex-wrap gap-2 px-4 py-4">
            <Badge variant="outline">
              {t("Observations: {{total}}", {
                total: compactNumberFormatter(user.data.totalObservations),
              })}
            </Badge>
            <Badge variant="outline">
              {t("Traces: {{total}}", {
                total: compactNumberFormatter(user.data.totalTraces),
              })}
            </Badge>
            <Badge variant="outline">
              {t("Total Tokens: {{total}}", {
                total: compactNumberFormatter(user.data.totalTokens),
              })}
            </Badge>
            <Badge variant="outline">
              <span className="flex items-center gap-1">
                {t("Total Cost: {{amount}}", {
                  amount: usdFormatter(user.data.sumCalculatedTotalCost),
                })}
              </span>
            </Badge>
            <Badge variant="outline">
              {t("Active:")}{" "}
              {user.data.firstTrace
                ? `${user.data.firstTrace.toLocaleString()} - ${user.data.lastTrace?.toLocaleString()}`
                : isBetaEnabled
                  ? t("No activity yet")
                  : t("No traces yet")}
            </Badge>
          </div>
        )}

        <div className="border-border border-t" />

        <div>
          <div className="sm:hidden">
            <label htmlFor="tabs" className="sr-only">
              {t("Select a tab")}
            </label>
            <select
              id="tabs"
              name="tabs"
              className="border-border bg-background text-foreground block w-full rounded-md py-2 pr-10 pl-3 text-base focus:outline-hidden sm:text-sm"
              defaultValue={currentTab}
              onChange={(e) => handleTabChange(e.currentTarget.value)}
            >
              {tabs.map((tab) => (
                <option key={tab} value={tab}>
                  {t(tabLabels[tab])}
                </option>
              ))}
            </select>
          </div>
          <div className="hidden sm:block">
            <div className="border-border border-b">
              <nav className="-mb-px flex" aria-label={t("Tabs")}>
                {tabs.map((tab) => (
                  <button
                    key={tab}
                    className={cn(
                      tab === currentTab
                        ? "border-primary-accent text-primary-accent"
                        : "text-muted-foreground hover:border-border hover:text-primary border-transparent",
                      "border-b-2 px-4 py-3 text-sm font-medium whitespace-nowrap",
                    )}
                    aria-current={tab === currentTab ? "page" : undefined}
                    onClick={() => handleTabChange(tab)}
                  >
                    {t(tabLabels[tab])}
                  </button>
                ))}
              </nav>
            </div>
          </div>
        </div>
        <div className="flex flex-1 overflow-hidden">{renderTabContent()}</div>
      </>
    </Page>
  );
}

type TabProps = {
  userId: string;
  projectId: string;
};

function ScoresTab({ userId, projectId }: TabProps) {
  return (
    <ScoresTable
      projectId={projectId}
      userId={userId}
      omittedFilter={["User ID"]}
    />
  );
}

function TracesTab({ userId, projectId }: TabProps) {
  const { isBetaEnabled } = useV4Beta();

  if (isBetaEnabled) {
    return <ObservationsEventsTable projectId={projectId} userId={userId} />;
  }

  return (
    <TracesTable
      projectId={projectId}
      userId={userId}
      omittedFilter={["User ID"]}
    />
  );
}

function SessionsTab({ userId, projectId }: TabProps) {
  const { isBetaEnabled } = useV4Beta();

  return (
    <SessionsTable
      projectId={projectId}
      userId={userId}
      omittedFilter={["User IDs"]}
      isBetaEnabled={isBetaEnabled}
    />
  );
}
