// @ts-nocheck
"use client";

import type { ReactNode } from "react";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { X } from "lucide-react";

export function Toggletip({
  content,
  children,
  show,
  onOpen,
  onClose,
  closeButton,
  placement = "bottom",
}: {
  content?: ReactNode;
  children?: ReactNode;
  show?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  closeButton?: boolean;
  placement?: string;
}) {
  return (
    <PopoverPrimitive.Root
      open={show}
      onOpenChange={(open) => {
        if (open) {
          onOpen?.();
        } else {
          onClose?.();
        }
      }}
    >
      <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side={placement as "top" | "right" | "bottom" | "left"}
          className="border-border bg-popover text-popover-foreground z-50 w-auto rounded border p-3 text-sm shadow-md"
          sideOffset={6}
        >
          {closeButton ? (
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground absolute top-2 right-2"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
          {content}
          <PopoverPrimitive.Arrow className="fill-border" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
