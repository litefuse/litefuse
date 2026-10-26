"use client";

// ── LITEFUSE NOTE (authored equivalent, not upstream code) ──────────────────
// Upstream's V4 migration moves ClickHouse telemetry from the old
// \`traces\`/\`observations\` pair to the events tables, and this badge nudges
// users to upgrade. Litefuse has no such migration: our telemetry already lives
// in the per-project split tables (\`spans_<projectId>\` /
// \`traces_scalar_<projectId>\`), so there is no "V4" for anyone to be behind on.
//
// What the call sites actually rely on is narrower: \`RuleNameCell\` renders this
// instead of its own \`<Badge variant="warning">Legacy</Badge>\` when the rule is
// legacy AND an upgrade handler exists. So the equivalent behaviour is that
// warning badge, clickable. Dropping it would silently remove the "this rule is
// legacy" signal, which is a real feature the evaluator UI needs.
//
// Replacement suggestion: none needed. If a telemetry migration ever appears,
// replace this with the real badge.
// ─────────────────────────────────────────────────────────────────────────────

import { Badge } from "@/src/components/ui/badge";
import { useTranslation } from "react-i18next";
import { cn } from "@/src/utils/tailwind";

export function V4MigrationBadgeContent({
  onClick,
  title,
  showChevron: _showChevron,
  compact,
  className,
}: {
  onClick?: () => void;
  title?: string;
  showChevron?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="warning"
      title={title}
      className={cn(compact && "px-1.5 py-0 text-[10px]", className)}
      {...(onClick
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            },
          }
        : {})}
    >
      {t("Legacy")}
    </Badge>
  );
}
