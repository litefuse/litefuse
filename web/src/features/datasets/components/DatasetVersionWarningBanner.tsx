import { Info } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/src/components/ui/button";

import { useTranslation } from "react-i18next";
type DatasetVersionWarningBannerProps = {
  selectedVersion: Date;
  resetToLatest: () => void;
  className?: string;
  changeCounts?: {
    upserts: number;
    deletes: number;
  };
};

export function DatasetVersionWarningBanner({
  selectedVersion,
  resetToLatest,
  className = "",
  changeCounts,
}: DatasetVersionWarningBannerProps) {
  const { t } = useTranslation();
  const totalChanges = changeCounts
    ? changeCounts.upserts + changeCounts.deletes
    : 0;
  const hasChanges = totalChanges > 0;

  return (
    <div
      className={`border-accent-dark-blue/10 bg-accent-light-blue/30 flex items-start gap-3 border-b p-3 ${className}`}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground text-sm wrap-break-word">
            {t("Viewing version from {{time}}", {
              time: format(selectedVersion, "PPp"),
            })}
          </p>
          <Button
            onClick={resetToLatest}
            variant="link"
            className="h-auto shrink-0 p-0 text-sm underline-offset-4"
          >
            {t("Return to latest")}
          </Button>
        </div>
        {changeCounts && hasChanges && (
          <p className="text-muted-foreground text-xs">
            {t("{{count}} change since this version,", {
              count: totalChanges,
            })}
            {changeCounts.upserts > 0 &&
              ` ${t("{{count}} upsert", { count: changeCounts.upserts })}`}
            {changeCounts.deletes > 0 &&
              ` ${t("{{count}} delete", { count: changeCounts.deletes })}`}
          </p>
        )}
      </div>
    </div>
  );
}
