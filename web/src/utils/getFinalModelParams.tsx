import {
  type ModelConfig,
  type ModelParams,
  type UIModelParams,
} from "@langfuse/shared";

export function getFinalModelParams(modelParams: UIModelParams): ModelParams {
  return Object.entries(modelParams)
    .filter(([key, value]) => value.enabled && key !== "maxTemperature")
    .reduce(
      (params, [key, value]) => ({ ...params, [key]: value.value }),
      {} as ModelParams,
    );
}

/**
 * LITEFUSE ADDITION (verbatim from upstream): the inverse of
 * `getFinalModelParams` — turn a flat stored model config into the UI's
 * `{ value, enabled }` shape. Used to seed `useModelParams` from a saved model
 * (the evaluators v2 judge-model dialog).
 */
export function getEnabledModelParamState(
  modelParams: ModelConfig,
): Partial<UIModelParams> {
  return Object.entries(modelParams).reduce<Partial<UIModelParams>>(
    (state, [key, value]) =>
      value === undefined
        ? state
        : {
            ...state,
            [key]: { value, enabled: true },
          },
    {},
  );
}
