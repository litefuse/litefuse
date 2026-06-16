// @ts-nocheck
"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/src/utils/tailwind";

export function CollapsibleSection({
  label,
  children,
  isOpen: defaultIsOpen = true,
  className,
}: {
  label?: ReactNode;
  children?: ReactNode;
  isOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultIsOpen);

  return (
    <CollapsiblePrimitive.Root
      open={open}
      onOpenChange={setOpen}
      className={cn(className)}
    >
      <CollapsiblePrimitive.Trigger className="hover:text-foreground flex w-full items-center gap-1 py-1 text-sm font-medium">
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {label}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content>{children}</CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

export { CollapsibleSection as CollapsableSection };
