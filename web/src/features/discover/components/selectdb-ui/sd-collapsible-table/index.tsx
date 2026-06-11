// @ts-nocheck
import React, { Fragment } from "react";
import {
  ColumnDef,
  Row,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EmptySearchResult } from "components/ui/empty-search-result";

interface SDCollapsibleTableProps<TData> {
  data: TData[];
  columns: Array<ColumnDef<TData>>;
  renderSubComponent: (props: { row: Row<TData> }) => React.ReactElement;
  getRowCanExpand: (row: Row<TData>) => boolean;
  className?: string;
}

export default function SDCollapsibleTable<T>(
  props: SDCollapsibleTableProps<T>,
) {
  const { data, columns, renderSubComponent, getRowCanExpand, className } =
    props;
  const table = useReactTable<any>({
    data,
    columns,
    getRowCanExpand,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  return (
    <table className={`w-full text-sm ${className ?? ""}`}>
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id} className="border-b">
            {headerGroup.headers.map((header) => {
              return (
                <th
                  key={header.id}
                  colSpan={header.colSpan}
                  className="bg-muted sticky top-0 z-2 h-12 px-4 text-left align-middle text-sm font-medium whitespace-nowrap"
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </th>
              );
            })}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.length > 0 ? (
          table.getRowModel().rows.map((row) => {
            return (
              <Fragment key={row.id}>
                <tr
                  id={row.original.selected ? "selected" : ""}
                  className={`hover:bg-muted/50 transition-colors ${row.getIsExpanded() ? "" : "border-b"} ${row.original.selected ? "bg-accent/60" : ""}`}
                >
                  {row.getVisibleCells().map((cell) => {
                    return (
                      <td key={cell.id} className="h-12 px-4 text-sm">
                        {cell.getContext().getValue() !== null
                          ? flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )
                          : "-"}
                      </td>
                    );
                  })}
                </tr>
                {row.getIsExpanded() && (
                  <tr className="hover:bg-muted/50 border-b transition-colors">
                    <td colSpan={row.getVisibleCells().length} className="p-0">
                      {renderSubComponent({ row })}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })
        ) : (
          <tr>
            <td colSpan={columns.length}>
              <EmptySearchResult>{`No Data`}</EmptySearchResult>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
