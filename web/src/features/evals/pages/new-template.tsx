import Page from "@/src/components/layouts/page";
import { EvalTemplateForm } from "@/src/features/evals/components/template-form";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { useRouter } from "next/router";

import { useTranslation } from "react-i18next";
export default function NewTemplatesPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const projectId = router.query.projectId as string;

  const hasAccess = useHasProjectAccess({
    projectId,
    scope: "evalTemplate:read",
  });

  if (!hasAccess) {
    return null;
  }

  return (
    <Page
      withPadding
      scrollable
      headerProps={{
        title: t("Create custom evaluator"),
        breadcrumb: [
          {
            name: t("Evaluators"),
            href: `/project/${projectId}/evals/templates`,
          },
        ],
      }}
    >
      <EvalTemplateForm
        projectId={projectId}
        isEditing={true}
        useDialog={false}
      />
    </Page>
  );
}
