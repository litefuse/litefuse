import { Code2, Scale, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EvalTemplateTypeEnum, type EvalTemplateType } from "@langfuse/shared";

import { i18nKey } from "@/src/features/i18n/i18nKey";

const METHOD_BADGES = {
  [EvalTemplateTypeEnum.CODE]: { Icon: Code2, label: i18nKey("Code") },
  [EvalTemplateTypeEnum.LLM_AS_JUDGE]: {
    Icon: Sparkles,
    label: i18nKey("LLM judge"),
  },
  [EvalTemplateTypeEnum.DECISION_MODEL]: {
    Icon: Scale,
    label: i18nKey("Decision model"),
  },
} as const satisfies Record<EvalTemplateType, { Icon: unknown; label: string }>;

export function EvaluatorGalleryMethodBadge({
  type,
}: {
  type: EvalTemplateType;
}) {
  const { t } = useTranslation();
  const { Icon, label } = METHOD_BADGES[type];

  return (
    <span className="bg-muted text-muted-foreground inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs leading-none whitespace-nowrap">
      <Icon className="size-3" />
      {t(label)}
    </span>
  );
}
