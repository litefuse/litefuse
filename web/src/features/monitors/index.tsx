// ── LITEFUSE NOTE (authored equivalent, not upstream code) ──────────────────
// Upstream has a monitors feature that owns severity presentation; Litefuse has
// no monitors (there is no \`features/monitors\` in our tree). The evaluator UI,
// however, has its own concept of an evaluator alert with a severity, so it needs
// something to render.
//
// This is the agreed fallback shape — "从我们现有的底层设计出发做类似功能": a badge
// built on our own \`components/ui/badge\`, showing the severity verbatim. It keeps
// the signal (how bad an alert is) without porting a monitors subsystem.
//
// Replacement suggestion: if monitors are ever brought over, delete this file and
// point the import at the real feature.
// ─────────────────────────────────────────────────────────────────────────────

import { Badge } from "@/src/components/ui/badge";

export function MonitorSeverityBadge({
  severity,
  className,
}: {
  severity: string;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={className}>
      {severity}
    </Badge>
  );
}
