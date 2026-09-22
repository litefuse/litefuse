import { isNumericDataType } from "@/src/features/scores/lib/helpers";
import { isPresent, type ScoreConfigDomain } from "@langfuse/shared";
import React from "react";

import { useTranslation } from "react-i18next";
export function ScoreConfigDetails({ config }: { config: ScoreConfigDomain }) {
  const { t } = useTranslation();
  const { name, description, minValue, maxValue, dataType } = config;
  if (!description && !isPresent(minValue) && !isPresent(maxValue)) return null;
  const isNameTruncated = name.length > 20;

  return (
    <div className="bg-background p-2 text-xs font-light text-wrap">
      {!!description && (
        <p>{t("Description: {{value}}", { value: description })}</p>
      )}
      {isNumericDataType(dataType) &&
      (isPresent(minValue) || isPresent(maxValue)) ? (
        <p>{`Range: [${minValue ?? "-∞"}, ${maxValue ?? "∞"}]`}</p>
      ) : null}
      {isNameTruncated && <p>{t("Full name: {{name}}", { name })}</p>}
    </div>
  );
}
