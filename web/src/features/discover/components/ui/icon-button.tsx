// @ts-nocheck
"use client";

import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/src/utils/tailwind";

import { Icon } from "./icon";

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  name: string;
  tooltip?: string;
  size?: "xs" | "sm" | "md" | "lg";
}

const SIZE_MAP = {
  xs: "h-5 w-5 p-0.5",
  sm: "h-6 w-6 p-1",
  md: "h-7 w-7 p-1",
  lg: "h-8 w-8 p-1.5",
};

export function IconButton({
  name,
  tooltip,
  size = "md",
  className,
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      title={tooltip}
      className={cn(
        "text-muted-foreground hover:bg-muted hover:text-foreground inline-flex cursor-pointer items-center justify-center rounded transition-colors focus-visible:outline-none disabled:opacity-50",
        SIZE_MAP[size],
        className,
      )}
    >
      <Icon name={name} className="h-full w-full" />
    </button>
  );
}
