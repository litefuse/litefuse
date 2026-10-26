import type { GetServerSideProps } from "next";
import { useTranslation } from "react-i18next";

// LITEFUSE: /evals/configs was the legacy (v1) job-configuration list before the
// evaluators UI moved to the canonical /evals paths and the legacy UI moved to
// /evals/legacy/**. The static route also shadows the dynamic
// /evals/[evaluatorId] route, which used to swallow this path and render a
// "evaluator not found" 404. This redirect keeps old /evals/configs bookmarks
// working (the legacy configs page itself then forwards to /evals/legacy).
export const getServerSideProps: GetServerSideProps = async (context) => {
  const projectId = context.params?.projectId as string;
  const queryString = context.resolvedUrl.split("?")[1];

  return {
    redirect: {
      destination: `/project/${encodeURIComponent(projectId)}/evals/legacy/configs${queryString ? `?${queryString}` : ""}`,
      permanent: false,
    },
  };
};

export default function EvaluatorConfigsRedirectPage() {
  const { t } = useTranslation();

  return <div className="p-3">{t("Redirecting...")}</div>;
}
