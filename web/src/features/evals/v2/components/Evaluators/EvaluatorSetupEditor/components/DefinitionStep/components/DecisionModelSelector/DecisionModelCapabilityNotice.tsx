import {
  isAllowedDecisionModel,
  supportedModels,
  supportsDecisionModels,
} from "@langfuse/shared";
import { useTranslation } from "react-i18next";
import { type TFunction } from "i18next";

/**
 * LITEFUSE ADDITION (gap D4): the decision-model picker only offers connections
 * whose adapter can actually answer a decision-model question, and only the
 * models `isAllowedDecisionModel` allows. This component makes the *excluded*
 * connections explicit, so a project that added an LLM connection for the Jev
 * judge sees why it is missing instead of an empty picker.
 *
 * It is purely presentational: the picker keeps its own option list, and this
 * notice only explains the connections that did not make it into that list.
 */
export type DecisionModelCapabilityConnection = {
  provider: string;
  adapter: string;
  customModels: string[];
  withDefaultModels: boolean;
};

/**
 * Mirrors the model list the picker builds (custom models first, then the
 * adapter defaults when the connection includes them).
 */
function getConnectionModels(connection: DecisionModelCapabilityConnection) {
  return [
    ...new Set(
      connection.withDefaultModels
        ? [
            ...connection.customModels,
            ...(supportedModels[
              connection.adapter as keyof typeof supportedModels
            ] ?? []),
          ]
        : connection.customModels,
    ),
  ];
}

export function getDecisionModelConnectionExclusionReason(
  connection: DecisionModelCapabilityConnection,
  t: TFunction,
): string | null {
  const label = `"${connection.provider}" (adapter "${connection.adapter}")`;

  // LITEFUSE: decision-model support is narrowed to TypeSafe (LITEFUSE NOTE in
  // `packages/shared/src/server/llm/types.ts`), so `supportsDecisionModels` and
  // `isDecisionModelAdapter` are now the same TypeSafe-only predicate. The branch
  // that used to explain "can serve decision models, but this deployment runs
  // them on TypeSafe connections only" is therefore unreachable — it only ever
  // fired for OpenAI, which no longer reports as decision-model capable — and was
  // removed rather than left as dead text.
  if (!supportsDecisionModels(connection.adapter)) {
    return t(
      "{{label}} cannot answer decision-model questions; decision-model evaluators need a TypeSafe or OpenAI connection.",
      { label },
    );
  }

  const hasAllowedModel = getConnectionModels(connection).some((model) =>
    isAllowedDecisionModel(connection.adapter, model),
  );
  if (!hasAllowedModel) {
    return t("{{label}} has no allowed decision model configured.", { label });
  }

  return null;
}

export function DecisionModelCapabilityNotice({
  connections,
}: {
  connections: DecisionModelCapabilityConnection[];
}) {
  const { t } = useTranslation();
  const reasons = connections
    .map((connection) =>
      getDecisionModelConnectionExclusionReason(connection, t),
    )
    .filter((reason): reason is string => reason !== null);

  if (reasons.length === 0) {
    return null;
  }

  return (
    <p className="text-muted-foreground text-xs">
      {t("Not available for decision models: {{reasons}}", {
        reasons: reasons.join(" "),
      })}
    </p>
  );
}
