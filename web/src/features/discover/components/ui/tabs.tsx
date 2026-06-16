// @ts-nocheck
"use client";

import type { ReactNode } from "react";

import { cn } from "@/src/utils/tailwind";

export function TabsBar({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("border-border flex border-b", className)}
      role="tablist"
    >
      {children}
    </div>
  );
}

export function Tab({
  label,
  active,
  onChangeTab,
  counter,
  children,
  className,
}: {
  label?: string;
  active?: boolean;
  onChangeTab?: () => void;
  counter?: number;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onChangeTab}
      className={cn(
        "-mb-px cursor-pointer border-b-2 px-4 py-2 text-sm transition-colors",
        active
          ? "border-primary text-foreground"
          : "text-muted-foreground hover:border-border hover:text-foreground border-transparent",
        className,
      )}
    >
      {label ?? children}
      {counter !== undefined ? (
        <span className="bg-muted text-muted-foreground ml-1 rounded px-1 py-0.5 text-xs">
          {counter}
        </span>
      ) : null}
    </button>
  );
}

export function TabContent({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return <div className={cn("py-2", className)}>{children}</div>;
}
