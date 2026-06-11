// @ts-nocheck
import React, { useState } from "react";
import { useAtom } from "jotai";
import { Plus, SlidersHorizontal, X } from "lucide-react";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/src/components/ui/popover";
import { dataFilterAtom, locationAtom } from "store/discover";
import { getFilterSQL } from "utils/data";
import { FilterContent } from "./filter-content";

export default function DiscoverFilter() {
  const [dataFilter, setDataFilter] = useAtom(dataFilterAtom);
  const [_loc, setLoc] = useAtom(locationAtom);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const removeFilter = (id: string) => {
    const nextFilters = dataFilter.filter((item) => item.id !== id);
    setDataFilter(nextFilters);
    setLoc((prev) => {
      const searchParams = prev.searchParams;
      searchParams?.set("data_filters", JSON.stringify(nextFilters));
      return {
        ...prev,
        searchParams,
      };
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="bg-primary/10 text-primary flex h-8 w-8 items-center justify-center rounded-md">
            <SlidersHorizontal className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">Filters</div>
            <div className="text-muted-foreground text-xs">
              Refine results without changing the base query.
            </div>
          </div>
        </div>

        <Popover open={createOpen} onOpenChange={setCreateOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="gap-2">
              <Plus className="h-4 w-4" />
              Add filter
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[26rem] p-0">
            <FilterContent onHide={() => setCreateOpen(false)} />
          </PopoverContent>
        </Popover>
      </div>

      {dataFilter.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {dataFilter.map((item) => {
            const text = item.label || getFilterSQL(item);
            const isOpen = editingId === item.id;

            return (
              <Popover
                key={item.id}
                open={isOpen}
                onOpenChange={(open) => setEditingId(open ? item.id : null)}
              >
                <div className="bg-muted/35 border-border flex items-center gap-1 rounded-md border pr-1.5">
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="max-w-[26rem] px-3 py-1.5 text-left text-sm"
                    >
                      <Badge
                        variant="secondary"
                        className="max-w-full truncate rounded-sm px-2 py-0.5 font-medium"
                      >
                        {text}
                      </Badge>
                    </button>
                  </PopoverTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground h-6 w-6"
                    onClick={() => removeFilter(item.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <PopoverContent align="start" className="w-[26rem] p-0">
                  <FilterContent
                    dataFilterValue={item}
                    onHide={() => setEditingId(null)}
                  />
                </PopoverContent>
              </Popover>
            );
          })}
        </div>
      ) : (
        <div className="border-border bg-muted/20 text-muted-foreground rounded-md border border-dashed px-3 py-3 text-sm">
          No filters applied.
        </div>
      )}
    </div>
  );
}
