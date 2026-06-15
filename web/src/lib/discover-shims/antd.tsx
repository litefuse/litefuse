/**
 * Shim for antd
 *
 * Provides minimal shadcn/ui-based replacements for the antd components
 * used in the discover plugin.
 */
"use client";

import React, { type ReactNode, type CSSProperties } from "react";
import { cn } from "@/src/utils/tailwind";

// ---------------------------------------------------------------------------
// Button  (antd-compatible Button)
// ---------------------------------------------------------------------------

interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "size"> {
  type?: "primary" | "default" | "dashed" | "text" | "link";
  size?: "large" | "middle" | "small";
  danger?: boolean;
  icon?: ReactNode;
  loading?: boolean;
  shape?: "default" | "circle" | "round";
  ghost?: boolean;
  children?: ReactNode;
}

export function Button({
  children,
  type = "default",
  size = "middle",
  danger,
  disabled,
  loading,
  shape,
  ghost,
  icon,
  className,
  ...rest
}: ButtonProps) {
  const sizeMap = {
    large: "h-9 px-4 text-sm",
    middle: "h-8 px-3 text-sm",
    small: "h-6 px-2 text-xs",
  };
  const typeMap: Record<string, string> = {
    primary: "bg-blue-600 text-white hover:bg-blue-700",
    default:
      "border border-border bg-background text-foreground hover:bg-muted",
    dashed:
      "border border-dashed border-border bg-background text-foreground hover:bg-muted",
    text: "bg-transparent text-foreground hover:bg-muted",
    link: "bg-transparent text-blue-600 hover:text-blue-700",
  };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-1 rounded font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        sizeMap[size],
        typeMap[type],
        danger && "border-red-500 text-red-500 hover:bg-red-50",
        shape === "circle" && "rounded-full",
        ghost && "border border-current bg-transparent",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

interface ProgressProps {
  percent?: number;
  strokeColor?: string;
  showInfo?: boolean;
  size?: number | "small" | "default";
  type?: "line" | "circle";
  status?: "success" | "exception" | "normal" | "active";
  className?: string;
  style?: CSSProperties;
}

export function Progress({
  percent = 0,
  strokeColor,
  showInfo = true,
  size,
  className,
  style,
}: ProgressProps) {
  return (
    <div className={cn("flex items-center gap-2", className)} style={style}>
      <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
        <div
          className="h-full rounded-full bg-blue-500 transition-all"
          style={{
            width: `${Math.min(100, Math.max(0, percent))}%`,
            backgroundColor: strokeColor,
          }}
        />
      </div>
      {showInfo && (
        <span className="text-muted-foreground w-9 text-right text-xs">
          {percent}%
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfigProvider  (antd theme provider — no-op in our context)
// ---------------------------------------------------------------------------

export interface ThemeConfig {
  token?: Record<string, any>;
  algorithm?: any;
  hashed?: boolean;
  components?: Record<string, any>;
}

export interface ConfigProviderProps {
  componentSize?: "small" | "middle" | "large";
  theme?: ThemeConfig;
  children?: ReactNode;
}

export function ConfigProvider({ children }: ConfigProviderProps) {
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// theme  (antd theme utilities — minimal stubs)
// ---------------------------------------------------------------------------

export const theme = {
  defaultAlgorithm: "default",
  darkAlgorithm: "dark",
  useToken: () => ({
    token: {
      colorBgContainer: "var(--background)",
      colorText: "var(--foreground)",
      colorBorder: "var(--border)",
      borderRadius: 6,
    },
    hashId: "",
  }),
};
