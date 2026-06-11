// @ts-nocheck
"use client";

import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/src/utils/tailwind";

import { Icon } from "./icon";

export function Badge({
  text,
  color,
  icon,
  tooltip,
  className,
  style,
}: {
  text?: ReactNode;
  color?: string;
  icon?: string;
  tooltip?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      title={tooltip}
      style={style}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium",
        color === "blue"
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {icon ? <Icon name={icon} className="h-3 w-3" /> : null}
      {text}
    </span>
  );
}
