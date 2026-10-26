/* eslint-disable no-nested-ternary */
import { useId, useState, type ReactNode } from "react";
import { ChevronDown, Plus, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { cn } from "@/src/utils/tailwind";
import { Label } from "@/src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  selectTriggerClassName,
} from "@/src/components/ui/select";
import { InfoTooltip } from "@/src/components/ui/InfoTooltip/InfoTooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/src/components/ui/popover";
import { ScoreDataTypeEnum } from "@langfuse/shared";
import { CategoryEditorPopover } from "./components/CategoryEditorPopover/CategoryEditorPopover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/src/components/ui/tooltip";
import { getScoreOutputValidation } from "@/src/features/evals/v2/fns/scoreOutput/getScoreOutputValidation";
import { i18nKey } from "@/src/features/i18n/i18nKey";

import {
  type ScoreOutputChoice,
  type ScoreOutputDataType,
  type ScoreOutputSelectorState,
} from "@/src/features/evals/v2/scoreOutputTypes";

const DATA_TYPE_OPTIONS: { value: ScoreOutputDataType; label: string }[] = [
  { value: ScoreDataTypeEnum.NUMERIC, label: i18nKey("number") },
  { value: ScoreDataTypeEnum.CATEGORICAL, label: i18nKey("category") },
  { value: ScoreDataTypeEnum.BOOLEAN, label: i18nKey("boolean") },
];

// Two empty rows — the minimum a categorical score needs, ready for labels.
const DEFAULT_CHOICES: ScoreOutputChoice[] = [{ label: "" }, { label: "" }];
const DEFAULT_MIN_VALUE = "0";
const DEFAULT_MAX_VALUE = "1";

/** A section label with its helper copy tucked into a hover tooltip instead
    of a permanent paragraph — keeps the label row compact. */
function LabelWithTooltip({
  htmlFor,
  label,
  tooltip,
  children,
}: {
  htmlFor?: string;
  label: string;
  tooltip: ReactNode | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Label htmlFor={htmlFor} className="flex items-center gap-1.5">
      {children}
      {tooltip ? (
        <InfoTooltip label={t("About {{label}}", { label })}>
          {tooltip}
        </InfoTooltip>
      ) : null}
    </Label>
  );
}

export type ScoreOutputConstraints = {
  dataTypes?: ScoreOutputDataType[];
  allowMultipleMatches?: boolean;
};

export function ScoreOutputSection({
  state,
  onChange,
  readOnly = false,
  constraints,
}: {
  state: ScoreOutputSelectorState;
  onChange: (next: ScoreOutputSelectorState) => void;
  readOnly?: boolean;
  constraints?: ScoreOutputConstraints;
}) {
  const boundsId = useId();
  const { t } = useTranslation();
  const dataTypeOptions = constraints?.dataTypes
    ? DATA_TYPE_OPTIONS.filter((option) =>
        constraints.dataTypes?.includes(option.value),
      )
    : DATA_TYPE_OPTIONS;
  const allowMultipleMatches = constraints?.allowMultipleMatches ?? true;
  const [addCategoryOpen, setAddCategoryOpen] = useState(false);
  const [editingChoiceIndex, setEditingChoiceIndex] = useState<number | null>(
    null,
  );
  const [newChoice, setNewChoice] = useState<ScoreOutputChoice>({ label: "" });
  const { categoryWarnings } = getScoreOutputValidation(state);

  const handleDataTypeChange = (dataType: ScoreOutputDataType) => {
    onChange({
      ...state,
      dataType,
      shouldAllowMultipleMatches:
        dataType === ScoreDataTypeEnum.CATEGORICAL
          ? state.shouldAllowMultipleMatches
          : false,
      choices:
        dataType === ScoreDataTypeEnum.CATEGORICAL && state.choices.length === 0
          ? DEFAULT_CHOICES
          : state.choices,
      minValue:
        dataType === ScoreDataTypeEnum.NUMERIC && !state.minValue.trim()
          ? DEFAULT_MIN_VALUE
          : state.minValue,
      maxValue:
        dataType === ScoreDataTypeEnum.NUMERIC && !state.maxValue.trim()
          ? DEFAULT_MAX_VALUE
          : state.maxValue,
    });
  };

  const updateChoice = (index: number, next: Partial<ScoreOutputChoice>) => {
    const choices = [...state.choices];
    choices[index] = { ...choices[index], ...next };
    onChange({ ...state, choices });
  };

  const handleAddCategoryOpenChange = (open: boolean) => {
    if (open) setNewChoice({ label: "" });
    setAddCategoryOpen(open);
  };

  const addChoice = () => {
    onChange({
      ...state,
      choices: [...state.choices, newChoice],
    });
  };

  const minimum = state.minValue.trim();
  const maximum = state.maxValue.trim();
  const numericBoundsLabel =
    minimum && maximum
      ? t("between {{min}} and {{max}}", { min: minimum, max: maximum })
      : minimum
        ? t("of at least {{min}}", { min: minimum })
        : maximum
          ? t("of at most {{max}}", { max: maximum })
          : t("without limits");

  return (
    <div className="flex flex-col gap-2">
      <LabelWithTooltip
        label={t("score output")}
        tooltip={
          readOnly
            ? null
            : t(
                "Use a number for continuous judgments like helpfulness. Use a category for explicit labels like correct or incorrect. Use a boolean for binary decisions like true or false.",
              )
        }
      >
        {t("Score output")}
      </LabelWithTooltip>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{t("Return")}</span>
        {state.dataType === ScoreDataTypeEnum.CATEGORICAL &&
        allowMultipleMatches ? (
          <Select
            value={state.shouldAllowMultipleMatches ? "multiple" : "one"}
            disabled={readOnly}
            onValueChange={(value) =>
              onChange({
                ...state,
                shouldAllowMultipleMatches: value === "multiple",
              })
            }
          >
            <SelectTrigger
              className="w-auto min-w-24"
              aria-label={t("Number of categories")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one">{t("one")}</SelectItem>
              <SelectItem value="multiple">{t("multiple")}</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span>{allowMultipleMatches ? t("a") : t("one")}</span>
        )}
        <Select
          value={state.dataType}
          disabled={readOnly || dataTypeOptions.length < 2}
          onValueChange={(value) =>
            handleDataTypeChange(value as ScoreOutputDataType)
          }
        >
          <SelectTrigger className="w-auto min-w-24" aria-label={t("Score type")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {dataTypeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.value === ScoreDataTypeEnum.CATEGORICAL &&
                state.shouldAllowMultipleMatches
                  ? t("categories")
                  : t(option.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {state.dataType === ScoreDataTypeEnum.NUMERIC && (
          <>
            {minimum || maximum ? <span>{t("with values")}</span> : null}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn(selectTriggerClassName, "w-auto")}
                  disabled={readOnly}
                >
                  {numericBoundsLabel}
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72">
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-sm font-bold">{t("Number limits")}</p>
                    <p className="text-muted-foreground text-sm">
                      {t("Set the minimum and maximum values for the score.")}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${boundsId}-minimum`}>
                        {t("Minimum")}
                      </Label>
                      <Input
                        id={`${boundsId}-minimum`}
                        type="number"
                        value={state.minValue}
                        onChange={(e) =>
                          onChange({
                            ...state,
                            minValue: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${boundsId}-maximum`}>
                        {t("Maximum")}
                      </Label>
                      <Input
                        id={`${boundsId}-maximum`}
                        type="number"
                        value={state.maxValue}
                        onChange={(e) =>
                          onChange({
                            ...state,
                            maxValue: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </>
        )}

        {state.dataType === ScoreDataTypeEnum.CATEGORICAL && (
          <>
            <span>{t("from")}</span>
            {state.choices.map((choice, index) => (
              <CategoryEditorPopover
                key={index}
                title={t("Edit category")}
                idSuffix={String(index)}
                choice={choice}
                open={editingChoiceIndex === index}
                onOpenChange={(open) =>
                  setEditingChoiceIndex(open ? index : null)
                }
                onChange={(next) => updateChoice(index, next)}
                onDelete={() => {
                  onChange({
                    ...state,
                    choices: state.choices.filter((_, i) => i !== index),
                  });
                  setEditingChoiceIndex(null);
                }}
                onDone={() => setEditingChoiceIndex(null)}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className={cn(selectTriggerClassName, "w-auto")}
                    disabled={readOnly}
                  >
                    <span>
                      {choice.label.trim() ||
                        t("Category {{index}}", { index: index + 1 })}
                    </span>
                    {categoryWarnings[index] ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="text-dark-yellow h-4 w-4 shrink-0"
                            aria-label={t("Warning: {{message}}", {
                              message: t(categoryWarnings[index]),
                            })}
                          >
                            <TriangleAlert
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t(categoryWarnings[index])}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                    {!readOnly ? (
                      <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                    ) : null}
                  </Button>
                </PopoverTrigger>
              </CategoryEditorPopover>
            ))}
            {!readOnly ? (
              <CategoryEditorPopover
                title={t("Add category")}
                idSuffix="new"
                choice={newChoice}
                onChange={(next) =>
                  setNewChoice((current) => ({ ...current, ...next }))
                }
                onDelete={null}
                onDone={() => {
                  addChoice();
                  setAddCategoryOpen(false);
                }}
                open={addCategoryOpen}
                onOpenChange={handleAddCategoryOpenChange}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t("Add category")}
                    title={t("Add category")}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
              </CategoryEditorPopover>
            ) : null}
          </>
        )}

        {state.dataType === ScoreDataTypeEnum.BOOLEAN && (
          <>
            <span>{t("as")}</span>
            <span className="bg-muted/50 text-foreground inline-flex h-8 items-center rounded-md border px-3 opacity-50">
              true
            </span>
            <span>{t("or")}</span>
            <span className="bg-muted/50 text-foreground inline-flex h-8 items-center rounded-md border px-3 opacity-50">
              false
            </span>
          </>
        )}
      </div>
    </div>
  );
}
