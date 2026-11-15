/** @jest-environment jsdom */
import React, { useMemo } from "react";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import isEqual from "lodash/isEqual";
import { tracePreviewKey } from "@/src/features/traces/lib/tracePreview";

// Exercise the production row memo and TableBody comparator together without
// importing the page's authentication, routing, database or network providers.
function declaration(file: string, name: string): ts.Expression {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(__dirname, "../../components/table", file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name)
      expression = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!expression) throw new Error(`Missing production declaration: ${name}`);
  return expression;
}
const rowExpression = declaration("use-cases/traces.tsx", "rows");
const memoExpression = declaration(
  "data-table.tsx",
  "MemoizedTableBody",
) as ts.AsExpression;
const comparator = (memoExpression.expression as ts.CallExpression)
  .arguments[1]!;
function javascript(expression: ts.Expression) {
  return (
    ts.transpileModule(`const extracted = ${expression.getText()};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText + "\nreturn extracted;"
  );
}
const deriveRows = new Function(
  "useMemo",
  "traces",
  "traceRowData",
  "previewsById",
  "tracePreviews",
  "tracePreviewKey",
  javascript(rowExpression),
);
const compare = new Function("isEqual", javascript(comparator))(isEqual);
const sourceRows = {
  rows: [
    { id: "trace-1", timestamp: new Date("2026-08-01T00:00:00Z"), tags: [] },
  ],
};
const snapshot = { rowSelection: {}, columnVisibility: {}, columnOrder: [] };
type PreviewState = {
  data?: Array<{ id: string; day: string; input: string }>;
  isPending: boolean;
  isError: boolean;
};
const Body = React.memo(
  ({
    data,
    renderPreview,
  }: {
    data: {
      data: Array<{ input?: unknown; previewLoading?: boolean }>;
      isLoading: boolean;
      isError: boolean;
    };
    tableSnapshot: typeof snapshot;
    renderPreview: (row: {
      input?: unknown;
      previewLoading?: boolean;
    }) => string;
  }) => React.createElement("span", null, renderPreview(data.data[0]!)),
  compare,
);
Body.displayName = "PreviewTableBodyHarness";
function Harness({ state }: { state: PreviewState }) {
  const previews = useMemo(
    () => new Map((state.data ?? []).map((p) => [tracePreviewKey(p), p])),
    [state.data],
  );
  const rows = deriveRows(
    useMemo,
    { isSuccess: true },
    sourceRows,
    previews,
    state,
    tracePreviewKey,
  );
  return React.createElement(Body, {
    data: { data: rows, isLoading: false, isError: false },
    tableSnapshot: snapshot,
    renderPreview: (row) => {
      // Before the fix the column closes over query state; afterward it reads
      // the preview/loading fields carried by the table row.
      const loading = row.previewLoading ?? (state.isPending && !state.isError);
      return loading
        ? "loading"
        : String(row.input ?? state.data?.[0]?.input ?? "empty");
    },
  });
}
const loaded = (input: string): PreviewState => ({
  data: [{ id: "trace-1", day: "2026-08-01", input }],
  isPending: false,
  isError: false,
});

test("peek body updates when only the asynchronous preview arrives and refreshes", () => {
  const page = render(
    React.createElement(Harness, {
      state: { isPending: true, isError: false },
    }),
  );
  expect(screen.getByText("loading")).toBeTruthy();
  page.rerender(
    React.createElement(Harness, { state: loaded("first preview") }),
  );
  expect(screen.getByText("first preview")).toBeTruthy();
  page.rerender(
    React.createElement(Harness, { state: loaded("refreshed preview") }),
  );
  expect(screen.getByText("refreshed preview")).toBeTruthy();
});
test("peek body stops loading when the preview request fails", () => {
  const page = render(
    React.createElement(Harness, {
      state: { isPending: true, isError: false },
    }),
  );
  expect(screen.getByText("loading")).toBeTruthy();
  page.rerender(
    React.createElement(Harness, {
      state: { isPending: false, isError: true },
    }),
  );
  expect(screen.getByText("empty")).toBeTruthy();
});
