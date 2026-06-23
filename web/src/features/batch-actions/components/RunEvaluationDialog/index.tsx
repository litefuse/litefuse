import { useMemo, useState } from "react";
import {
  BatchEvalSourceTable,
  type BatchEvalSourceTable as BatchEvalSourceTableType,
  getEvalTargetObjectFromSourceTable,
  type BatchActionQuery,
} from "@langfuse/shared";
import { api } from "@/src/utils/api";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/dialog";
import { Button } from "@/src/components/ui/button";
import { showErrorToast } from "@/src/features/notifications/showErrorToast";
import { showSuccessToast } from "@/src/features/notifications/showSuccessToast";
import { ChevronLeft } from "lucide-react";
import { EvaluatorSelectionStep } from "./EvaluatorSelectionStep";
import { ConfirmationStep } from "./ConfirmationStep";
import { CreateEvaluatorDialog } from "./CreateEvaluatorDialog";
import { buildQueryWithSelectedIds } from "./utils";
import { useV4Beta } from "@/src/features/events/hooks/useV4Beta";

type RunEvaluationDialogProps = {
  projectId: string;
  selectedObservationIds: string[];
  query: BatchActionQuery;
  selectAll: boolean;
  totalCount: number;
  onClose: () => void;
  exampleObservation: {
    id: string;
    traceId: string;
    startTime?: Date;
  };
  sourceTable?: BatchEvalSourceTableType;
};

type DialogStep = "select-evaluator" | "confirm";

export function RunEvaluationDialog(props: RunEvaluationDialogProps) {
  const { isBetaEnabled } = useV4Beta();
  const { projectId, selectedObservationIds, query, selectAll, totalCount } =
    props;
  const sourceTable = props.sourceTable ?? BatchEvalSourceTable.EVENTS;

  const [step, setStep] = useState<DialogStep>("select-evaluator");
  const [selectedEvaluatorIds, setSelectedEvaluatorIds] = useState<string[]>(
    [],
  );
  const [evaluatorSearchQuery, setEvaluatorSearchQuery] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const targetObject = getEvalTargetObjectFromSourceTable(sourceTable);

  const evaluatorsQuery = api.evals.jobConfigsByTarget.useQuery({
    projectId,
    targetObject,
  });

  const runEvaluationMutation =
    api.batchAction.runEvaluation.create.useMutation({
      onError: (error) => {
        showErrorToast("Failed to schedule evaluation", error.message);
      },
    });

  const displayCount = selectAll ? totalCount : selectedObservationIds.length;
  const scopeLabel =
    sourceTable === BatchEvalSourceTable.TRACES ? "trace" : "observation";

  const previewObservationQuery = api.observations.byId.useQuery(
    {
      projectId,
      observationId: props.exampleObservation.id,
      traceId: props.exampleObservation.traceId,
      startTime: props.exampleObservation.startTime ?? null,
    },
    {
      enabled: Boolean(
        !isBetaEnabled &&
          props.exampleObservation.id &&
          props.exampleObservation.traceId,
      ),
    },
  );

  const previewEventQuery = api.events.batchIO.useQuery(
    {
      projectId,
      observations: [
        {
          id: props.exampleObservation.id,
          traceId: props.exampleObservation.traceId,
        },
      ],
      minStartTime: props.exampleObservation.startTime as Date,
      maxStartTime: props.exampleObservation.startTime as Date,
      truncated: false,
    },
    {
      enabled: Boolean(
        isBetaEnabled &&
          props.exampleObservation.id &&
          props.exampleObservation.traceId &&
          props.exampleObservation.startTime,
      ),
    },
  );

  const eligibleEvaluators = useMemo(() => {
    return (evaluatorsQuery.data ?? []).filter(
      (evaluator) => evaluator.targetObject === targetObject,
    );
  }, [evaluatorsQuery.data, targetObject]);

  const selectedEvaluators = useMemo(
    () =>
      eligibleEvaluators.filter((evaluator) =>
        selectedEvaluatorIds.includes(evaluator.id),
      ),
    [eligibleEvaluators, selectedEvaluatorIds],
  );

  const toggleEvaluatorSelection = (evaluatorId: string) => {
    setSelectedEvaluatorIds((previous) =>
      previous.includes(evaluatorId)
        ? previous.filter((id) => id !== evaluatorId)
        : [...previous, evaluatorId],
    );
  };

  const onSubmit = async () => {
    if (selectedEvaluators.length === 0) {
      return;
    }

    const finalQuery = buildQueryWithSelectedIds({
      query,
      selectAll,
      selectedObservationIds,
    });

    try {
      await runEvaluationMutation.mutateAsync({
        projectId,
        query: finalQuery,
        evaluatorIds: selectedEvaluators.map((evaluator) => evaluator.id),
        sourceTable,
      });
    } catch {
      return;
    }

    showSuccessToast({
      title: "Evaluation queued",
      description: `Scheduled evaluation for ${displayCount} selected ${displayCount === 1 ? scopeLabel : `${scopeLabel}s`} and ${selectedEvaluators.length} ${selectedEvaluators.length === 1 ? "evaluator" : "evaluators"}.`,
      link: {
        href: `/project/${projectId}/settings/batch-actions`,
        text: "View batch actions",
      },
    });

    props.onClose();
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && props.onClose()}>
        <DialogContent className="flex max-h-[62vh] min-h-[38vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>
              Evaluate {displayCount} {scopeLabel}
              {displayCount === 1 ? "" : "s"}
            </DialogTitle>
            <DialogDescription>
              {step === "confirm"
                ? "Review your evaluation configuration before running."
                : `Select one or more ${scopeLabel}-scoped evaluators.`}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="flex-1 overflow-hidden">
            {step === "select-evaluator" ? (
              <EvaluatorSelectionStep
                eligibleEvaluators={eligibleEvaluators}
                selectedEvaluators={selectedEvaluators}
                isQueryLoading={evaluatorsQuery.isLoading}
                isQueryError={evaluatorsQuery.isError}
                queryErrorMessage={evaluatorsQuery.error?.message}
                previewObservation={
                  isBetaEnabled
                    ? previewEventQuery.data?.[0]
                    : previewObservationQuery.data
                }
                isPreviewLoading={
                  previewObservationQuery.isLoading ||
                  previewEventQuery.isLoading
                }
                evaluatorScopeLabel={scopeLabel}
                selectedEvaluatorIds={selectedEvaluatorIds}
                evaluatorSearchQuery={evaluatorSearchQuery}
                onSearchQueryChange={setEvaluatorSearchQuery}
                onToggleEvaluator={toggleEvaluatorSelection}
                onCreateEvaluator={() => setShowCreateDialog(true)}
              />
            ) : (
              <ConfirmationStep
                projectId={projectId}
                displayCount={displayCount}
                evaluators={selectedEvaluators.map((e) => ({
                  id: e.id,
                  name: e.scoreName,
                }))}
                sourceTable={sourceTable}
              />
            )}
          </DialogBody>

          <DialogFooter className="flex justify-between">
            {step === "confirm" ? (
              <Button
                variant="ghost"
                onClick={() => setStep("select-evaluator")}
                disabled={runEvaluationMutation.isPending}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
            ) : (
              <div />
            )}

            {step === "select-evaluator" ? (
              <Button
                onClick={() => setStep("confirm")}
                disabled={selectedEvaluators.length === 0}
              >
                Continue{" "}
                {selectedEvaluators.length > 0
                  ? `with ${selectedEvaluators.length} evaluator(s)`
                  : null}
              </Button>
            ) : (
              <Button
                onClick={onSubmit}
                loading={runEvaluationMutation.isPending}
              >
                Run Evaluation
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateEvaluatorDialog
        projectId={projectId}
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        targetObject={targetObject}
      />
    </>
  );
}
