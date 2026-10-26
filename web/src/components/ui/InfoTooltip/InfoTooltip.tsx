import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/src/components/ui/tooltip";

export function InfoTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <InfoIcon
          className="text-muted-foreground h-3.5 w-3.5"
          aria-label={label}
        />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  );
}
