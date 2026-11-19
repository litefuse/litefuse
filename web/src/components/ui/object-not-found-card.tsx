import { Card } from "@/src/components/ui/card";
import { SearchXIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";

type NotFoundObject = "TRACE" | "OBSERVATION" | "SESSION";

const OBJECT_LABELS: Record<NotFoundObject, string> = {
  TRACE: i18nKey("Trace"),
  OBSERVATION: i18nKey("Observation"),
  SESSION: i18nKey("Session"),
};

export const ObjectNotFoundCard = ({ type }: { type: NotFoundObject }) => {
  const { t } = useTranslation();
  return (
    <Card className="flex h-full items-center justify-center p-6">
      <div className="text-center">
        <SearchXIcon className="text-muted-foreground mx-auto mb-2 h-8 w-8" />
        <p className="text-muted-foreground text-sm">
          {t("{{object}} not found. Likely deleted.", {
            object: t(OBJECT_LABELS[type]),
          })}
        </p>
      </div>
    </Card>
  );
};
