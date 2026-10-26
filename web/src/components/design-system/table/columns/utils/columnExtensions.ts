import type * as React from "react";

// ── LITEFUSE NOTE (authored file, not an upstream copy) ─────────────────────
// Upstream declares these on \`LangfuseColumnDef\` in
// \`components/table/types.ts\` (its ExtendedColumnDef): an optional
// \`loadingCell\`, \`cellPadding\` and \`cellBackground\` on every column, plus the
// \`DataTableCellBackground\` / \`DataTableCellPadding\` unions.
//
// Our (older) type has none of them. Adding them there would mean editing a file
// outside the evaluator module, so the column creators below take them from
// here instead. They are pure type additions — same names, same shapes.
//
// ⚠️ RECONCILIATION ITEM (step 3): our \`components/table/data-table.tsx\` does
// not read \`loadingCell\`, so those skeleton placeholders render as empty cells
// in our tables. Nothing else in our tree reads these three props either, so
// declaring them here is behaviour-neutral for now; aligning the data table is
// the real fix.
// ─────────────────────────────────────────────────────────────────────────────

export type DataTableCellPadding = "compact" | "comfortable" | "none";
export type DataTableCellBackground = "gray" | "green";

export type LangfuseColumnExtensions = {
  loadingCell?: React.ReactNode | (() => React.ReactNode);
  cellPadding?: DataTableCellPadding;
  cellBackground?: DataTableCellBackground;
};
