import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/src/components/ui/dropdown-menu";
import { Button } from "@/src/components/ui/button";
import { ChevronDown } from "lucide-react";
import { type EventsViewMode } from "@/src/features/events/hooks/useEventsViewMode";

import { i18nKey } from "@/src/features/i18n/i18nKey";
import { useTranslation } from "react-i18next";
export interface EventsViewModeToggleProps {
  viewMode: EventsViewMode;
  onViewModeChange: (mode: EventsViewMode) => void;
}

const VIEW_MODE_OPTIONS: Record<
  EventsViewMode,
  { label: string; description: string }
> = {
  trace: {
    label: i18nKey("Traces"),
    description: i18nKey("Root-level observations, the top nodes in a trace."),
  },
  observation: {
    label: i18nKey("Observations"),
    description: i18nKey("All observations of all trace trees."),
  },
};

export function EventsViewModeToggle({
  viewMode,
  onViewModeChange,
}: EventsViewModeToggleProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1">
          {VIEW_MODE_OPTIONS[viewMode].label}
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {(
          Object.entries(VIEW_MODE_OPTIONS) as [
            EventsViewMode,
            { label: string; description: string },
          ][]
        ).map(([key, { label, description }]) => (
          <DropdownMenuItem
            key={key}
            onClick={() => onViewModeChange(key)}
            className="flex flex-col items-start"
          >
            <span>{t(label)}</span>
            <span className="text-muted-foreground text-xs">
              {t(description)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
