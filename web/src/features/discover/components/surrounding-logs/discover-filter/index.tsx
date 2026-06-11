// @ts-nocheck
import React, { useState } from "react";
import { useAtom } from "jotai";
import { FilterContent } from "./filter-content";
import { surroundingDataFilterAtom } from "store/discover";
import { getFilterSQL } from "utils/data";
import { DiscoverFilterProps } from "../types";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { X, Plus } from "lucide-react";

export default function SurroundingDiscoverFilter(props: DiscoverFilterProps) {
  const [surroundingDataFilter, setSurroundingDataFilter] = useAtom(
    surroundingDataFilterAtom,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2">
      <span className="text-muted-foreground text-xs font-medium">Filter</span>
      {surroundingDataFilter.map((dataFilterValue) => (
        <div key={dataFilterValue.id} className="relative">
          <Badge
            variant="secondary"
            className="hover:bg-secondary cursor-pointer gap-1 pr-1"
            onClick={() =>
              setEditingId(
                editingId === dataFilterValue.id ? null : dataFilterValue.id,
              )
            }
          >
            <span className="max-w-50 truncate">
              {dataFilterValue.label
                ? dataFilterValue.label
                : getFilterSQL(dataFilterValue)}
            </span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground ml-1"
              onClick={(e) => {
                e.stopPropagation();
                setSurroundingDataFilter(
                  surroundingDataFilter.filter((f) => f !== dataFilterValue),
                );
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
          {editingId === dataFilterValue.id && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setEditingId(null)}
              />
              <div className="bg-background border-border absolute top-full left-0 z-50 mt-1 rounded-md border p-3 shadow-md">
                <FilterContent
                  onHide={() => setEditingId(null)}
                  dataFilterValue={dataFilterValue}
                />
              </div>
            </>
          )}
        </div>
      ))}
      <div className="relative">
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setCreateOpen(!createOpen)}
        >
          <Plus className="h-3 w-3" />
          Add filter
        </Button>
        {createOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setCreateOpen(false)}
            />
            <div className="bg-background border-border absolute top-full left-0 z-50 mt-1 rounded-md border p-3 shadow-md">
              <FilterContent onHide={() => setCreateOpen(false)} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
