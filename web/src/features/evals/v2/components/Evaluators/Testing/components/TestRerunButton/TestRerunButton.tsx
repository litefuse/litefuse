import { Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/src/components/ui/button";

export function TestRerunButton({
  isPending,
  disabledReason,
  onRerun,
}: {
  isPending: boolean;
  disabledReason: string | null;
  onRerun: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      loading={isPending}
      disabled={disabledReason !== null}
      title={disabledReason ? t(disabledReason) : t("Run the test again")}
      onClick={onRerun}
    >
      <Play className="mr-1.5 h-3.5 w-3.5" />
      {t("Run again")}
    </Button>
  );
}
