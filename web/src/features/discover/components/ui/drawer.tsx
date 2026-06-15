// @ts-nocheck
"use client";

import type { ReactNode } from "react";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/src/utils/tailwind";

export function Drawer({
  title,
  subtitle,
  isOpen,
  onClose,
  children,
  width,
  size = "md",
  className,
}: {
  title?: string;
  subtitle?: string;
  isOpen?: boolean;
  onClose?: () => void;
  children?: ReactNode;
  width?: string | number;
  size?: "sm" | "md" | "lg";
  scrollableContent?: boolean;
  className?: string;
}) {
  const sizeMap = {
    sm: "w-72",
    md: "w-[480px]",
    lg: "w-[720px]",
  };

  return (
    <DialogPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose?.();
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <DialogPrimitive.Content
          style={
            width
              ? { width: typeof width === "number" ? `${width}px` : width }
              : undefined
          }
          className={cn(
            "bg-background fixed top-0 right-0 z-50 flex h-full flex-col shadow-xl",
            !width && sizeMap[size],
            className,
          )}
        >
          <div className="border-border flex items-center justify-between border-b p-4">
            <div>
              {title ? (
                <DialogPrimitive.Title className="text-base font-semibold">
                  {title}
                </DialogPrimitive.Title>
              ) : null}
              {subtitle ? (
                <p className="text-muted-foreground text-xs">{subtitle}</p>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="hover:bg-muted rounded p-1"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
              </button>
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-auto p-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
