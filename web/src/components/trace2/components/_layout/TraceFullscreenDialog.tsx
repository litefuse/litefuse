import { type ReactNode } from "react";
import { Maximize2 } from "lucide-react";

import { Button } from "@/src/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/src/components/ui/dialog";
import { cn } from "@/src/utils/tailwind";

type TraceFullscreenDialogProps = {
  title: string;
  triggerTitle: string;
  children: ReactNode;
  triggerClassName?: string;
};

export function TraceFullscreenDialog({
  title,
  triggerTitle,
  children,
  triggerClassName,
}: TraceFullscreenDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          title={triggerTitle}
          aria-label={triggerTitle}
          className={cn("h-7 w-7", triggerClassName)}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="h-[calc(100dvh-1rem)] max-h-none w-[calc(100vw-1rem)] max-w-none sm:rounded-lg"
        closeOnInteractionOutside
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="min-h-0 overflow-hidden p-0">
          <div className="h-full min-h-0 overflow-hidden">{children}</div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
