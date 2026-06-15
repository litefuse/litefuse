// @ts-nocheck
"use client";

import type { CSSProperties, ReactNode } from "react";

import { Input as SharedInput } from "@/src/components/ui/input";
import { cn } from "@/src/utils/tailwind";

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "prefix" | "size"> {
  prefix?: ReactNode;
  size?: "sm" | "md" | "lg";
  suffix?: ReactNode;
  addonAfter?: ReactNode;
  invalid?: boolean;
  width?: number | string;
}

function resolveWidthStyle(
  width?: number | string,
  style?: CSSProperties,
): CSSProperties | undefined {
  if (width === undefined) {
    return style;
  }

  return {
    ...style,
    width: typeof width === "number" ? `${width}rem` : width,
  };
}

export function Input({
  prefix,
  suffix,
  addonAfter,
  invalid,
  size: _size,
  width,
  className,
  style,
  ...props
}: InputProps) {
  return (
    <div className="flex" style={resolveWidthStyle(width, style)}>
      {prefix ? (
        <span className="border-border bg-muted text-muted-foreground flex items-center rounded-l border border-r-0 px-2 text-sm">
          {prefix}
        </span>
      ) : null}
      <SharedInput
        {...props}
        className={cn(
          prefix && "rounded-l-none",
          (suffix || addonAfter) && "rounded-r-none",
          invalid && "border-destructive focus-visible:ring-destructive",
          className,
        )}
      />
      {suffix ? (
        <span className="border-border bg-muted text-muted-foreground flex items-center rounded-r border border-l-0 px-2 text-sm">
          {suffix}
        </span>
      ) : null}
      {addonAfter ? (
        <span className="border-border bg-muted text-muted-foreground flex items-center rounded-r border border-l-0 px-2 text-sm">
          {addonAfter}
        </span>
      ) : null}
    </div>
  );
}
