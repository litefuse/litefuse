"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/src/utils/tailwind";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-[calc(var(--radix-popover-content-available-height)-1rem)] max-w-[max(var(--radix-popover-trigger-width),fit-content)] min-w-72 overflow-y-auto rounded-md border p-3 shadow-md outline-hidden",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

const PopoverClose = PopoverPrimitive.Close;

// ── Added for the evaluators v2 migration (copied from upstream) ─────────────
const PopoverAnchor = PopoverPrimitive.Anchor;

/**
 * Owns popover open state while callers retain trigger and content presentation.
 * Use the supplied Trigger to preserve Radix behavior.
 */
type PopoverControllerProps = {
  align: React.ComponentProps<typeof PopoverContent>["align"];
  children: (control: {
    disabled: boolean;
    isOpen: boolean;
    openPopover: () => void;
    Anchor: typeof PopoverAnchor;
    Trigger: typeof PopoverTrigger;
  }) => React.ReactNode;
  contentClassName: string;
  disabled: boolean;
  modal: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  renderContent: (control: { closePopover: () => void }) => React.ReactNode;
};

const PopoverController = ({
  align,
  children,
  contentClassName,
  disabled,
  modal,
  onOpenChange,
  renderContent,
}: PopoverControllerProps) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const handleOpenChange = (nextIsOpen: boolean) => {
    if (nextIsOpen && disabled) return;

    setIsOpen(nextIsOpen);
    onOpenChange?.(nextIsOpen);
  };

  return (
    <Popover modal={modal} open={isOpen} onOpenChange={handleOpenChange}>
      {children({
        disabled,
        isOpen,
        openPopover: () => handleOpenChange(true),
        Anchor: PopoverAnchor,
        Trigger: PopoverTrigger,
      })}
      <PopoverContent
        align={align}
        className={contentClassName}
        onClick={(event) => event.stopPropagation()}
      >
        {renderContent({ closePopover: () => setIsOpen(false) })}
      </PopoverContent>
    </Popover>
  );
};
export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverClose,
  PopoverAnchor,
  PopoverController,
};
