import { type GetServerSideProps } from "next";
import { useRouter } from "next/router";

import { useTranslation } from "react-i18next";
// This url is deprecated, we keep this redirect page for backward compatibility
export const getServerSideProps: GetServerSideProps = async (context) => {
  if (!context.params) {
    return {
      notFound: true,
    };
  }
  const projectId = context.params.projectId as string;

  return {
    redirect: {
      destination: `/project/${projectId}/evals`,
      permanent: false,
    },
  };
};

export default function RedirectPage() {
  const { t } = useTranslation();
  const router = useRouter();
  if (router.isFallback) {
    return <div className="p-3">{t("Loading...")}</div>;
  }

  return <div>{t("Redirecting...")}</div>;
}
