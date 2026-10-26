/* eslint-disable no-nested-ternary */
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";

import { Stepper } from "@/src/features/evals/v2/components/Stepper/Stepper";
import { EvaluatorAssignmentsEditor } from "@/src/features/evals/v2/components/Rules/EvaluatorAssignmentsEditor/EvaluatorAssignmentsEditor";
import { buildSelectedSampleObject } from "@/src/features/evals/v2/fns/evaluatorTesting/buildSelectedSampleObject";
import type {
  RuleEvaluatorOption,
  RuleSetupStore,
} from "@/src/features/evals/v2/types/rules";
import { api, sendAsPostOption } from "@/src/utils/api";

export function RuleEvaluatorsStep({
  projectId,
  evaluatorOptions,
  store,
  search,
  onSearchChange,
}: {
  projectId: string;
  evaluatorOptions: RuleEvaluatorOption[];
  store: RuleSetupStore;
  search: string;
  onSearchChange: (search: string) => void;
}) {
  const { t } = useTranslation();
  const selectedObservation = useStore(
    store,
    (state) => state.selectedObservation,
  );
  const selectedObservationDetails = api.events.experimentBatchIO.useQuery(
    {
      projectId,
      observations: [
        {
          id: selectedObservation?.id ?? "",
          traceId: selectedObservation?.traceId ?? "",
        },
      ],
      minStartTime: selectedObservation?.startTime ?? new Date(0),
      maxStartTime: selectedObservation?.startTime ?? new Date(0),
      truncated: false,
      includeToolCalls: true,
    },
    {
      ...sendAsPostOption,
      enabled: Boolean(
        selectedObservation?.id &&
        selectedObservation.traceId &&
        selectedObservation.startTime,
      ),
      select: (data) => data[0],
    },
  );
  const sampleObject = buildSelectedSampleObject({
    observation: selectedObservation,
    eventDetails: selectedObservationDetails.data,
  });
  const assignments = useStore(store, (state) => state.assignments);
  // LITEFUSE: the weekly cost estimate used to live here. It is hidden because
  // the test-run cost is never computed in this fork — the footer showed
  // "Unavailable" (or a permanent skeleton) and the estimate call behind it even
  // probes an unpriced evaluator with a *real* LLM request. Passing no estimates
  // keeps the assignment rows (and the rest of the step) untouched while nothing
  // cost-related is fetched or displayed.
  void assignments;

  return (
    <Stepper
      number={2}
      title={t("Attach evaluators")}
      description={t(
        "Choose which evaluators should run on matching observations.",
      )}
    >
      <EvaluatorAssignmentsEditor
        evaluatorOptions={evaluatorOptions}
        store={store}
        search={search}
        onSearchChange={onSearchChange}
        sampleObject={sampleObject}
        costEstimates={[]}
        estimatingEvaluatorIds={[]}
        footerTrailing={null}
      />
    </Stepper>
  );
}
