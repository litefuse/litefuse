/* eslint-disable no-nested-ternary */
import { useRouter } from "next/router";
import { EvalTemplateTypeEnum } from "@langfuse/shared";
import { useTranslation } from "react-i18next";

import { SupportOrUpgradePage } from "@/src/components/SupportOrUpgradePage";
import { Skeleton } from "@/src/components/ui/skeleton";
import { useEvalTemplate } from "@/src/features/evals/v2/hooks/useEvalTemplate";
import { useHasProjectAccess } from "@/src/features/rbac";
import { EvaluatorSetupPage } from "./EvaluatorSetupPage";

function requestedEvaluatorType(value: string | string[] | undefined) {
  return value === EvalTemplateTypeEnum.CODE
    ? EvalTemplateTypeEnum.CODE
    : value === EvalTemplateTypeEnum.DECISION_MODEL
      ? EvalTemplateTypeEnum.DECISION_MODEL
      : EvalTemplateTypeEnum.LLM_AS_JUDGE;
}

export default function NewEvaluatorPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const projectId = router.query.projectId as string;
  // Creating an evaluator needs `evaluator:CUD`. The list page already hides
  // its entry point for read-only roles; this keeps a typed URL from rendering
  // an editor whose every save would be rejected server-side.
  const canCreate = useHasProjectAccess({
    projectId,
    scope: "evaluator:CUD",
  });
  const templateKey =
    typeof router.query.template === "string" ? router.query.template : null;
  const evaluatorId =
    typeof router.query.evaluatorId === "string"
      ? router.query.evaluatorId
      : null;
  const template = useEvalTemplate({
    projectId,
    templateKey,
    evaluatorId,
    enabled: router.isReady && canCreate,
  });

  if (!router.isReady) {
    return <Skeleton className="m-6 h-96 w-[calc(100%-3rem)]" />;
  }

  if (!canCreate) {
    return <SupportOrUpgradePage />;
  }

  if (template.isPending) {
    return <Skeleton className="m-6 h-96 w-[calc(100%-3rem)]" />;
  }

  if (template.isNotFound) {
    return (
      <div className="p-6">{t("Evaluator template not found")}</div>
    );
  }

  const initialType = requestedEvaluatorType(router.query.type);
  const creationSource = templateKey
    ? { type: "managed" as const, templateKey }
    : evaluatorId
      ? { type: "custom" as const }
      : { type: "scratch" as const };

  return (
    <EvaluatorSetupPage
      mode="create"
      key={templateKey ?? evaluatorId ?? initialType}
      projectId={projectId}
      initialDraft={template.draft}
      initialType={initialType}
      creationSource={creationSource}
    />
  );
}
