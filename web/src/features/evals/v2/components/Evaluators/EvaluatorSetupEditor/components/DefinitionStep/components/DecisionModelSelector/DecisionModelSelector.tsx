import {
  isAllowedDecisionModel,
  isDecisionModelAdapter,
  supportedModels,
} from "@langfuse/shared";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";

import { Button } from "@/src/components/ui/button";
import { SelectInput } from "@/src/components/design-system/SelectInput/SelectInput";
import { DecisionModelCapabilityNotice } from "@/src/features/evals/v2/components/Evaluators/EvaluatorSetupEditor/components/DefinitionStep/components/DecisionModelSelector/DecisionModelCapabilityNotice";
import type { EvaluatorSetupStore } from "@/src/features/evals/v2/store/evaluatorSetupStore/evaluatorSetupStore";
import { api } from "@/src/utils/api";

const SEPARATOR = "::";

/**
 * Picks the decision-model connection and model version. Decision models have
 * no project default and no sampling parameters, so this replaces the judge
 * model picker with a flat list of `provider :: model` options.
 */
export function DecisionModelSelector({
  projectId,
  store,
  onConfigureProviders,
}: {
  projectId: string;
  store: EvaluatorSetupStore;
  onConfigureProviders: () => void;
}) {
  const { t } = useTranslation();
  const selectedModel = useStore(store, (state) => state.selectedModel);
  const selectModel = store.getState().actions.selectModel;
  const connections = api.llmApiKey.all.useQuery({
    projectId,
    includeDecisionModels: true,
  });

  // LITEFUSE ADDITION (gap D4): a connection is offered only when it can run
  // decision models in this deployment (`isDecisionModelAdapter`), and a model is
  // offered only when the capability registry allows it for that adapter
  // (`isAllowedDecisionModel`). The filters can only remove entries —
  // capabilities never make an adapter selectable that the execution path
  // cannot run.
  //
  // LITEFUSE: decision-model support is narrowed to TypeSafe (LITEFUSE NOTE in
  // `packages/shared/src/server/llm/types.ts`), so the adapter half of that pair
  // — `supportsDecisionModels` — is now the same TypeSafe-only predicate as
  // `isDecisionModelAdapter`, and the upstream OpenAI case is gone. One adapter
  // check is kept instead of ANDing two identical predicates; that is
  // behaviour-identical today and stays correct if the widening is ever restored,
  // because the execution gate is what decides.
  const options = (connections.data?.data ?? [])
    .filter((connection) => isDecisionModelAdapter(connection.adapter))
    .flatMap((connection) => {
      const models = connection.withDefaultModels
        ? [...connection.customModels, ...supportedModels[connection.adapter]]
        : connection.customModels;
      // A connection usually repeats the adapter's default model in its
      // customModels (our TypeSafe preset stores `jev-latest` while
      // supportedModels.typesafe already lists it), which used to render the
      // same option twice. De-duplicate while keeping the first occurrence, so
      // custom models stay ahead of the defaults.
      return [...new Set(models)]
        .filter((model) => isAllowedDecisionModel(connection.adapter, model))
        .map((model) => ({
          value: `${connection.provider}${SEPARATOR}${model}`,
          label: `${connection.provider}: ${model}`,
        }));
    });

  // LITEFUSE ADDITION (gap D4): name the connections the gate above kept out of
  // the picker instead of letting them disappear silently. It is only rendered
  // when the picker would otherwise be empty: once a decision-model connection is
  // selectable, listing the excluded ones next to a working picker reads like an
  // error state.
  const capabilityNotice = (
    <DecisionModelCapabilityNotice connections={connections.data?.data ?? []} />
  );

  if (connections.isSuccess && options.length === 0) {
    return (
      <>
        <Button type="button" variant="outline" onClick={onConfigureProviders}>
          {t("Add a decision-model connection")}
        </Button>
        {capabilityNotice}
      </>
    );
  }

  return (
    <div className="max-w-xs min-w-56">
      <SelectInput
        aria-label={t("Decision model")}
        placeholder={t("Select a decision model")}
        value={
          selectedModel
            ? `${selectedModel.provider}${SEPARATOR}${selectedModel.model}`
            : ""
        }
        options={options}
        onValueChange={(value) => {
          const separatorIndex = value.indexOf(SEPARATOR);
          if (separatorIndex === -1) return;
          selectModel({
            provider: value.slice(0, separatorIndex),
            model: value.slice(separatorIndex + SEPARATOR.length),
          });
        }}
      />
    </div>
  );
}
