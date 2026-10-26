import type { GetServerSideProps } from "next";
import { useTranslation } from "react-i18next";

// LITEFUSE: /evals/v2/rules was the temporary route of the migrated evaluators UI before
// the routes were aligned with upstream. The new UI now lives on the canonical
// paths (/evals, /evals/new, /evals/rules, /evals/<evaluatorId>) and the legacy
// UI moved to /evals/legacy/**. This redirect keeps old /evals/v2 bookmarks (and
// any copied-v2 link that still points here) working.
export const getServerSideProps: GetServerSideProps = async (context) => {
  const projectId = context.params?.projectId as string;
  const queryString = context.resolvedUrl.split("?")[1];

  return {
    redirect: {
      destination: `/project/${encodeURIComponent(projectId)}/evals/rules${queryString ? `?${queryString}` : ""}`,
      permanent: false,
    },
  };
};

export default function EvaluatorsV2RedirectPage() {
  const { t } = useTranslation();

  return <div className="p-3">{t("Redirecting...")}</div>;
}
