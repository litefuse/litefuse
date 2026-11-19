import { CardContent } from "@/src/components/ui/card";
import { Card } from "@/src/components/ui/card";
import { ManageDefaultEvalModel } from "@/src/features/evals/components/manage-default-eval-model";

import { useTranslation } from "react-i18next";
export function SetupDefaultEvalModelCard({
  projectId,
}: {
  projectId: string;
}) {
  const { t } = useTranslation();
  return (
    <Card className="border-dark-yellow bg-light-yellow mt-2">
      <CardContent className="mt-2 flex flex-col gap-1">
        <ManageDefaultEvalModel
          projectId={projectId}
          setUpMessage={t(
            "Set up default evaluation model to use this evaluator",
          )}
          variant="color-coded"
        />
        <p className="text-dark-yellow/70 text-xs">
          {t(
            "This evaluator expects to use the default evaluation model for your project.",
          )}
        </p>
      </CardContent>
    </Card>
  );
}
