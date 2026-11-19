/**
 * TracePanelNavigationLayoutDesktop - Desktop-specific layout wrapper for navigation panel
 *
 * Responsibility:
 * - Wrap navigation content with header and collapsible layout structure
 * - Handle panel collapse/expand state for desktop
 * - Position TracePanelNavigationHiddenNotice above content
 * - Render graph view panel below tree/timeline when enabled
 *
 * Hooks:
 * - useDesktopLayoutContext() - for panel collapse state
 * - useViewPreferences() - for showGraph preference
 * - useGraphData() - for isGraphViewAvailable
 *
 * Re-renders when:
 * - Panel collapse/expand state changes
 * - showGraph or isGraphViewAvailable changes
 * - Does NOT re-render when search/selection changes (isolated)
 */

import { type ReactNode } from "react";
import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
} from "@/src/components/ui/resizable";
import { useDesktopLayoutContext } from "./TraceLayoutDesktop";
import { TracePanelNavigationHeader } from "./TracePanelNavigationHeader";
import { TracePanelNavigationHiddenNotice } from "./TracePanelNavigationHiddenNotice";
import { TraceFullscreenDialog } from "./TraceFullscreenDialog";

import { useTranslation } from "react-i18next";
export function TracePanelNavigationLayoutDesktop({
  children,
  secondaryContent,
}: {
  children: ReactNode;
  secondaryContent?: ReactNode;
}) {
  const { t } = useTranslation();
  const { isNavigationPanelCollapsed, handleTogglePanel, shouldPulseToggle } =
    useDesktopLayoutContext();

  return (
    <div className="flex h-full flex-col border-r">
      <TracePanelNavigationHeader
        isPanelCollapsed={isNavigationPanelCollapsed}
        onTogglePanel={handleTogglePanel}
        shouldPulseToggle={shouldPulseToggle}
      />
      {!isNavigationPanelCollapsed && (
        <>
          <TracePanelNavigationHiddenNotice />
          {secondaryContent ? (
            <ResizablePanelGroup
              orientation="vertical"
              className="flex-1 overflow-hidden"
            >
              <ResizablePanel defaultSize="60%" minSize="20%">
                <div className="h-full overflow-hidden">{children}</div>
              </ResizablePanel>
              <ResizableHandle className="bg-border h-px" />
              <ResizablePanel defaultSize="40%" minSize="20%">
                <div className="flex h-full flex-col overflow-hidden">
                  <div className="flex h-8 shrink-0 items-center justify-between border-b px-2">
                    <span className="text-xs font-medium">
                      {t("Graph View")}
                    </span>
                    <TraceFullscreenDialog
                      title={t("Graph View")}
                      triggerTitle={t("Open Graph fullscreen")}
                    >
                      {secondaryContent}
                    </TraceFullscreenDialog>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    {secondaryContent}
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="flex-1 overflow-hidden">{children}</div>
          )}
        </>
      )}
    </div>
  );
}
