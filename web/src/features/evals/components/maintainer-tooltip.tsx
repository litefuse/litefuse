import { LangfuseIcon } from "@/src/components/LangfuseLogo";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/src/components/ui/tooltip";
import { RagasLogoIcon } from "@/src/features/evals/components/ragas-logo";
import { UserCircle2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";

function MaintainerIcon({ maintainer }: { maintainer: string }) {
  if (maintainer.includes("Ragas")) {
    return <RagasLogoIcon />;
  } else if (
    maintainer.includes("Litefuse") ||
    maintainer.includes("Langfuse")
  ) {
    return <LangfuseIcon size={16} />;
  } else {
    return <UserCircle2Icon className="h-4 w-4" />;
  }
}

export function MaintainerTooltip({ maintainer }: { maintainer: string }) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger>
        <MaintainerIcon maintainer={maintainer} />
      </TooltipTrigger>
      <TooltipContent>{t(maintainer)}</TooltipContent>
    </Tooltip>
  );
}
