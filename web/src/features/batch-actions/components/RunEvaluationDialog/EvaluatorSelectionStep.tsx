import { useMemo } from "react";
import { observationVariableMappingList } from "@langfuse/shared";
import { type RouterOutputs } from "@/src/utils/api";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent } from "@/src/components/ui/card";
import { Badge } from "@/src/components/ui/badge";
import { Checkbox } from "@/src/components/ui/checkbox";
import { Input } from "@/src/components/ui/input";
import { EvaluatorPromptPreview } from "./EvaluatorPromptPreview";
import {
  renderPromptPreviewFromObservation,
  TEMPLATE_HAS_NO_PROMPT,
} from "./utils";
import { Eye, Plus, X } from "lucide-react";

import { useTranslation } from "react-i18next";
type Evaluator = RouterOutputs["evals"]["jobConfigsByTarget"][number];
type ObservationPreview = RouterOutputs["observations"]["byId"];

type EvaluatorSelectionStepProps = {
  eligibleEvaluators: Evaluator[];
  selectedEvaluators: Evaluator[];
  isQueryLoading: boolean;
  isQueryError: boolean;
  queryErrorMessage: string | undefined;
  previewObservation: ObservationPreview | undefined;
  isPreviewLoading: boolean;
  selectedEvaluatorIds: string[];
  evaluatorSearchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onToggleEvaluator: (evaluatorId: string) => void;
  onCreateEvaluator: () => void;
};

export function EvaluatorSelectionStep(props: EvaluatorSelectionStepProps) {
  const { t } = useTranslation();
  const {
    eligibleEvaluators,
    selectedEvaluators,
    isQueryLoading,
    isQueryError,
    queryErrorMessage,
    previewObservation,
    isPreviewLoading,
    selectedEvaluatorIds,
    evaluatorSearchQuery,
    onSearchQueryChange,
    onToggleEvaluator,
    onCreateEvaluator,
  } = props;

  const filteredEvaluators = useMemo(() => {
    const normalizedSearch = evaluatorSearchQuery.trim().toLowerCase();
    const filtered = normalizedSearch
      ? eligibleEvaluators.filter((evaluator) => {
          const templateName = evaluator.evalTemplate?.name ?? "";

          return (
            evaluator.scoreName.toLowerCase().includes(normalizedSearch) ||
            templateName.toLowerCase().includes(normalizedSearch)
          );
        })
      : eligibleEvaluators;

    return [...filtered].sort((a, b) =>
      a.scoreName.localeCompare(b.scoreName, undefined, {
        sensitivity: "base",
      }),
    );
  }, [eligibleEvaluators, evaluatorSearchQuery]);

  const getPromptPreview = (evaluator: Evaluator) => {
    if (isPreviewLoading) {
      return t("Loading preview...");
    }

    if (!previewObservation) {
      return t("Preview unavailable for the current selection.");
    }

    const mappingResult = observationVariableMappingList.safeParse(
      evaluator.variableMapping,
    );

    if (!mappingResult.success) {
      return t("Evaluator mapping is not valid for observation preview.");
    }

    const preview = renderPromptPreviewFromObservation({
      prompt: evaluator.evalTemplate?.prompt,
      variableMapping: mappingResult.data,
      observation: previewObservation,
    });
    // Only the sentinel is copy; the rest is the rendered prompt.
    return preview === TEMPLATE_HAS_NO_PROMPT ? t(preview) : preview;
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="min-h-0 flex-1">
        {isQueryLoading ? (
          <p className="text-muted-foreground text-sm">
            {t("Loading evaluators...")}
          </p>
        ) : isQueryError ? (
          <Card>
            <CardContent className="text-destructive p-4 text-sm">
              {t("Failed to load evaluators: {{error}}", {
                error: queryErrorMessage,
              })}
            </CardContent>
          </Card>
        ) : eligibleEvaluators.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground p-4 text-sm">
              {t(
                "No observation-scoped evaluators found. Create a new observation-scoped evaluator and it will appear here.",
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="relative">
              <Input
                autoFocus
                className="pr-10"
                placeholder={t("Search evaluators...")}
                value={evaluatorSearchQuery}
                onChange={(event) =>
                  onSearchQueryChange(event.currentTarget.value)
                }
              />
              {evaluatorSearchQuery.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-1/2 right-1.5 h-7 w-7 -translate-y-1/2"
                  onClick={() => onSearchQueryChange("")}
                  aria-label={t("Clear evaluator search")}
                >
                  <X className="h-3 w-3" />
                </Button>
              ) : null}
            </div>

            <div className="px-1 pb-1">
              <div className="flex min-h-6 flex-wrap items-center gap-2">
                {selectedEvaluators.length > 0 ? (
                  selectedEvaluators.map((evaluator) => (
                    <EvaluatorPromptPreview
                      key={evaluator.id}
                      previewContent={getPromptPreview(evaluator)}
                      trigger={
                        <div>
                          <Badge
                            variant="secondary"
                            className="flex items-center gap-1 pr-1"
                          >
                            <span>{evaluator.scoreName}</span>
                            <button
                              type="button"
                              aria-label={`Remove ${evaluator.scoreName}`}
                              className="hover:bg-muted rounded p-0.5"
                              onClick={() => onToggleEvaluator(evaluator.id)}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        </div>
                      }
                    />
                  ))
                ) : (
                  <p className="text-muted-foreground text-xs">
                    {t("No evaluators selected")}
                  </p>
                )}
              </div>
            </div>

            {filteredEvaluators.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border">
                <p className="text-muted-foreground p-4 text-sm">
                  {t("No evaluators match your search.")}
                </p>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
                {filteredEvaluators.map((item, index, array) => (
                  <div key={item.id}>
                    <div
                      className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 px-2 py-1.5 transition-colors"
                      onClick={() => onToggleEvaluator(item.id)}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {item.scoreName}
                        </p>
                        <p className="text-muted-foreground truncate text-[11px]">
                          {t("Template: {{name}}", {
                            name:
                              item.evalTemplate?.name ?? t("Deleted template"),
                          })}
                        </p>
                      </div>
                      <EvaluatorPromptPreview
                        previewContent={getPromptPreview(item)}
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-7 w-7"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`Preview ${item.scoreName}`}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        }
                      />
                      <Checkbox
                        checked={selectedEvaluatorIds.includes(item.id)}
                        aria-label={`Select ${item.scoreName}`}
                        onClick={(event) => event.stopPropagation()}
                        onCheckedChange={() => onToggleEvaluator(item.id)}
                        className="mr-1"
                      />
                    </div>
                    {index < array.length - 1 ? (
                      <div className="border-border/50 border-b" />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <Button
        variant="outline"
        size="default"
        className="h-9 w-full"
        onClick={onCreateEvaluator}
      >
        <Plus className="mr-1 h-4 w-4" />
        {t("Create new Evaluator")}
      </Button>
    </div>
  );
}
