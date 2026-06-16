// @ts-nocheck
"use client";

import type { ReactNode } from "react";

import { AlertCircle } from "lucide-react";

import { cn } from "@/src/utils/tailwind";

export function EmptySearchResult({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex flex-col items-center justify-center gap-2 py-8",
        className,
      )}
    >
      <AlertCircle className="h-8 w-8 opacity-40" />
      <p className="text-sm">{children ?? "No results found"}</p>
    </div>
  );
}
