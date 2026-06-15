// @ts-nocheck
"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/src/utils/tailwind";

export function Pagination({
  currentPage = 1,
  numberOfPages = 1,
  onNavigate,
  hideWhenSinglePage,
  className,
}: {
  currentPage?: number;
  numberOfPages?: number;
  onNavigate?: (page: number) => void;
  hideWhenSinglePage?: boolean;
  className?: string;
}) {
  if (hideWhenSinglePage && numberOfPages <= 1) {
    return null;
  }

  return (
    <div className={cn("flex items-center gap-1 text-sm", className)}>
      <button
        type="button"
        disabled={currentPage <= 1}
        onClick={() => onNavigate?.(currentPage - 1)}
        className="hover:bg-muted rounded p-1 disabled:opacity-40"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="text-muted-foreground px-2 text-xs">
        {currentPage} / {numberOfPages}
      </span>
      <button
        type="button"
        disabled={currentPage >= numberOfPages}
        onClick={() => onNavigate?.(currentPage + 1)}
        className="hover:bg-muted rounded p-1 disabled:opacity-40"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
