import { StringParam, useQueryParam } from "use-query-params";
import { NewPromptForm } from "@/src/features/prompts/components/NewPromptForm";
import useProjectIdFromURL from "@/src/hooks/useProjectIdFromURL";
import { api } from "@/src/utils/api";
import Page from "@/src/components/layouts/page";

import { useTranslation } from "react-i18next";
export const NewPrompt = () => {
  const { t } = useTranslation();
  const projectId = useProjectIdFromURL();
  const [initialPromptId] = useQueryParam("promptId", StringParam);

  const { data: initialPrompt, isInitialLoading } = api.prompts.byId.useQuery(
    {
      projectId: projectId as string, // Typecast as query is enabled only when projectId is present
      id: initialPromptId ?? "",
    },
    {
      enabled: Boolean(initialPromptId && projectId),
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  );

  if (isInitialLoading) {
    return <div className="p-3">{t("Loading...")}</div>;
  }

  const breadcrumb: { name: string; href?: string }[] = [
    {
      name: t("Prompts"),
      href: `/project/${projectId}/prompts/`,
    },
    {
      name: t("New prompt"),
    },
  ];

  if (initialPrompt) {
    breadcrumb.pop(); // Remove the "New prompt" entry
    breadcrumb.push(
      {
        name: initialPrompt.name,
        href: `/project/${projectId}/prompts/${encodeURIComponent(initialPrompt.name)}`,
      },
      { name: t("New version") },
    );
  }

  return (
    <Page
      withPadding
      scrollable
      headerProps={{
        title: initialPrompt
          ? t("{{name}} — New version", { name: initialPrompt.name })
          : t("Create new prompt"),
        help: {
          description: t(
            "Manage and version your prompts in Litefuse. Edit and update them via the UI and SDK. Retrieve the production version via the SDKs. Learn more in the docs.",
          ),
          href: "https://litefuse.ai/docs/prompts",
        },
        breadcrumb: breadcrumb,
      }}
    >
      {initialPrompt ? (
        <p className="text-muted-foreground text-sm">
          {t(
            "Prompts are immutable in Litefuse. To update a prompt, create a new version.",
          )}
        </p>
      ) : null}
      <div className="my-8">
        <NewPromptForm {...{ initialPrompt }} />
      </div>
    </Page>
  );
};
