import { DecisionModelQuestionType } from "@langfuse/shared";
import { Gauge, ListChecks, ToggleLeft, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/src/utils/tailwind";
import { i18nKey } from "@/src/features/i18n/i18nKey";

export const QUESTION_TYPE_COPY: Record<
  DecisionModelQuestionType,
  {
    label: string;
    icon: LucideIcon;
    summary: string;
    writes: string;
    example: string;
    whenToUse: string;
  }
> = {
  [DecisionModelQuestionType.CHOICE]: {
    label: i18nKey("Choice"),
    icon: ListChecks,
    summary: i18nKey("Pick one of a fixed set of labels."),
    writes: i18nKey("a categorical score"),
    example: i18nKey("Which team should handle this ticket?"),
    whenToUse: i18nKey(
      "The answer is one of a few options with no order between them. Add an “other” option if the list may not cover every input.",
    ),
  },
  [DecisionModelQuestionType.SCORE]: {
    label: i18nKey("Score"),
    icon: Gauge,
    summary: i18nKey("Rate along ordered levels you describe."),
    writes: i18nKey("a numeric score (the expected level)"),
    example: i18nKey("How frustrated is the customer?"),
    whenToUse: i18nKey(
      "The answer sits on a spectrum you can describe in steps. Describe situations, not degrees: “broken but a workaround exists” beats “moderately severe”.",
    ),
  },
  [DecisionModelQuestionType.NOUL]: {
    label: i18nKey("Yes / no"),
    icon: ToggleLeft,
    summary: i18nKey("Get the probability a statement is true."),
    writes: i18nKey("a numeric score (probability 0–1)"),
    example: i18nKey("Does the message request a refund?"),
    whenToUse: i18nKey(
      "A clean yes/no where the probability itself is the signal. Define the condition precisely; 0.5 means undecided, not “medium”.",
    ),
  },
};

const ORDER: DecisionModelQuestionType[] = [
  DecisionModelQuestionType.CHOICE,
  DecisionModelQuestionType.SCORE,
  DecisionModelQuestionType.NOUL,
];

/**
 * Picks the question type. All three primitives stay visible with their
 * descriptor so the model's vocabulary is learned where it is used.
 */
export function QuestionTypeSelector({
  value,
  onValueChange,
  disabled = false,
}: {
  value: DecisionModelQuestionType;
  onValueChange: (value: DecisionModelQuestionType) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const active = QUESTION_TYPE_COPY[value];
  return (
    <div className="@container flex flex-col gap-1.5">
      <div
        role="radiogroup"
        aria-label={t("Question type")}
        className="grid gap-2 @lg:grid-cols-3"
      >
        {ORDER.map((type) => {
          const copy = QUESTION_TYPE_COPY[type];
          const selected = type === value;
          return (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onValueChange(type)}
              className={cn(
                "flex flex-col gap-1 rounded-md border p-3 text-left text-sm transition-colors",
                "hover:bg-muted/50 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-hidden",
                selected
                  ? "border-primary-accent bg-primary-accent/5 ring-primary-accent ring-1"
                  : "border-border",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <span className="flex items-center gap-1.5 font-bold">
                <copy.icon className="h-4 w-4 shrink-0" />
                {t(copy.label)}
              </span>
              <span className="text-muted-foreground">{t(copy.summary)}</span>
              <span className="text-muted-foreground text-xs italic">
                {t("e.g. “{{example}}”", { example: t(copy.example) })}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-muted-foreground text-xs">
        {t("Writes {{writes}}. {{whenToUse}}", {
          writes: t(active.writes),
          whenToUse: t(active.whenToUse),
        })}
      </p>
    </div>
  );
}
