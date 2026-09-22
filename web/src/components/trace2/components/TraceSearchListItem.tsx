/**
 * SearchListItem - Individual search result row
 *
 * Renders a single search result using ItemBadge + SpanContent.
 * Reuses SpanContent from tree view for consistency.
 * Displays relative timestamps to show temporal context within the trace.
 */

import { type TraceSearchListItem } from "../lib/types";
import { ItemBadge } from "@/src/components/ItemBadge";
import { SpanContent } from "./SpanContent";
import { cn } from "@/src/utils/tailwind";
import { useTraceData } from "../contexts/TraceDataContext";
import { formatIntervalSeconds } from "@/src/utils/dates";

import { useTranslation } from "react-i18next";
interface TraceSearchListItemProps {
  item: TraceSearchListItem;
  isSelected: boolean;
  onSelect: () => void;
  onHover?: () => void;
}

export function TraceSearchListItem({
  item,
  isSelected,
  onSelect,
  onHover,
}: TraceSearchListItemProps) {
  const { t } = useTranslation();
  const { node, parentTotalCost, parentTotalDuration } = item;
  const { comments } = useTraceData();

  // Format relative timestamps
  const traceRelativeTime = formatIntervalSeconds(
    node.startTimeSinceTrace / 1000,
  );
  const parentRelativeTime =
    node.startTimeSinceParentStart !== null
      ? formatIntervalSeconds(node.startTimeSinceParentStart / 1000)
      : null;

  return (
    <div
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        "hover:bg-muted/50 flex cursor-pointer items-start gap-2 px-2 py-1.5 transition-colors",
        isSelected && "bg-muted",
      )}
    >
      <ItemBadge type={node.type} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <SpanContent
          node={node}
          parentTotalCost={parentTotalCost}
          parentTotalDuration={parentTotalDuration}
          commentCount={comments.get(node.id)}
          onSelect={onSelect}
        />
        {/* Temporal and depth context - only show for observations (not TRACE root) */}
        {node.type !== "TRACE" && (
          <div className="text-muted-foreground/70 text-xs">
            {t("depth {{depth}} • +{{time}}", {
              depth: node.depth,
              time: traceRelativeTime,
            })}
            {parentRelativeTime !== null &&
              ` ${t("• +{{time}} from parent", { time: parentRelativeTime })}`}
          </div>
        )}
      </div>
    </div>
  );
}
