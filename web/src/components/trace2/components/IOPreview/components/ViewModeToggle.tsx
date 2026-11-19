import { Tabs, TabsList, TabsTrigger } from "@/src/components/ui/tabs";
import { Switch } from "@/src/components/ui/switch";
import { useJsonBetaToggle } from "@/src/components/trace2/hooks/useJsonBetaToggle";

import { useTranslation } from "react-i18next";
export type ViewMode = "pretty" | "json" | "json-beta";

export interface ViewModeToggleProps {
  selectedView: ViewMode;
  onViewChange: (view: ViewMode) => void;
  compensateScrollRef: React.RefObject<HTMLDivElement | null>;
}

export function ViewModeToggle({
  selectedView,
  onViewChange,
  compensateScrollRef,
}: ViewModeToggleProps) {
  const { t } = useTranslation();
  const {
    jsonBetaEnabled,
    selectedViewTab,
    handleViewTabChange,
    handleBetaToggle,
  } = useJsonBetaToggle(selectedView, onViewChange);

  return (
    <div className="flex w-full flex-row items-center justify-start gap-1.5">
      <Tabs
        ref={compensateScrollRef}
        className="h-fit py-0.5"
        value={selectedViewTab}
        onValueChange={handleViewTabChange}
      >
        <TabsList className="h-fit p-0.5">
          <TabsTrigger value="pretty" className="h-fit px-1 text-xs">
            {t("Formatted")}
          </TabsTrigger>
          <TabsTrigger value="json" className="h-fit px-1 text-xs">
            JSON
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {selectedViewTab === "json" && (
        <div className="flex items-center gap-1.5">
          <Switch
            size="sm"
            checked={jsonBetaEnabled}
            onCheckedChange={handleBetaToggle}
          />
          <span className="text-muted-foreground text-xs">{t("Beta")}</span>
        </div>
      )}
    </div>
  );
}
