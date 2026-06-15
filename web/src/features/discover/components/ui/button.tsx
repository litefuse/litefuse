// @ts-nocheck
"use client";

import type { ButtonHTMLAttributes } from "react";

import {
  Button as SharedButton,
  type ButtonProps as SharedButtonProps,
} from "@/src/components/ui/button";
import { cn } from "@/src/utils/tailwind";

import { Icon } from "./icon";

type DiscoverButtonVariant =
  | "primary"
  | "secondary"
  | "destructive"
  | "success";
type DiscoverButtonSize = "sm" | "md" | "lg";
type DiscoverButtonFill = "solid" | "outline" | "text";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: DiscoverButtonVariant;
  size?: DiscoverButtonSize;
  icon?: string;
  fill?: DiscoverButtonFill;
  fullWidth?: boolean;
}

const SIZE_MAP: Record<DiscoverButtonSize, SharedButtonProps["size"]> = {
  sm: "sm",
  md: "default",
  lg: "lg",
};

function resolveVariant(
  variant: DiscoverButtonVariant,
  fill: DiscoverButtonFill,
): SharedButtonProps["variant"] {
  if (variant === "destructive") {
    return "destructive";
  }

  if (fill === "outline") {
    return "outline";
  }

  if (fill === "text") {
    return "ghost";
  }

  return variant === "secondary" ? "secondary" : "default";
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  fill = "solid",
  fullWidth = false,
  className,
  ...props
}: ButtonProps) {
  const isSuccess = variant === "success";

  return (
    <SharedButton
      {...props}
      size={SIZE_MAP[size]}
      variant={resolveVariant(variant, fill)}
      className={cn(
        fullWidth && "w-full",
        fill === "text" && "bg-transparent shadow-none",
        fill === "text" && variant === "secondary" && "text-muted-foreground",
        fill === "text" && variant === "primary" && "text-primary",
        isSuccess && "bg-green-600 text-white hover:bg-green-700",
        className,
      )}
    >
      {icon ? <Icon name={icon} className="mr-1.5 h-3.5 w-3.5" /> : null}
      {children}
    </SharedButton>
  );
}
