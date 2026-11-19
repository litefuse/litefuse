import React from "react";
import Header from "@/src/components/layouts/header";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { ScoreConfigsTable } from "@/src/components/table/use-cases/score-configs";

import { Trans, useTranslation } from "react-i18next";
export function ScoreConfigSettings({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const hasReadAccess = useHasProjectAccess({
    projectId: projectId,
    scope: "scoreConfigs:read",
  });

  if (!hasReadAccess) return null;

  return (
    <div id="score-configs">
      <Header title={t("Score Configs")} />
      <p className="mb-2 text-sm">
        <Trans
          i18nKey="Score configs define which scores are available for <0>annotation</0> in your project. Please note that all score configs are immutable."
          components={[
            <a
              key="0"
              href="https://litefuse.ai/docs/evaluation/evaluation-methods/annotation"
              className="underline"
              target="_blank"
              rel="noopener noreferrer"
            />,
          ]}
        />
      </p>
      <ScoreConfigsTable projectId={projectId} />
    </div>
  );
}
