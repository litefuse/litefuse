// @ts-nocheck
"use client";

import { RefreshCw } from "lucide-react";

export function LoadingPlaceholder({ text }: { text?: string }) {
  return (
    <div className="text-muted-foreground flex items-center justify-center p-4 text-sm">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      {text || "Loading..."}
    </div>
  );
}
