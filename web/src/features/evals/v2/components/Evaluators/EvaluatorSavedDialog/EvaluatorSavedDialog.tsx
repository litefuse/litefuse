import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/src/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
} from "@/src/components/ui/collapsible";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/dialog";
import { RadioGroup } from "@/src/components/design-system/RadioGroup/RadioGroup";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/src/components/ui/tooltip";
import { i18nKey } from "@/src/features/i18n/i18nKey";
import { cn } from "@/src/utils/tailwind";
import styles from "./EvaluatorSavedDialog.module.css";

export type EvaluatorSavedMode = "test-filters" | "different-scope";

const modeOptions = [
  {
    value: "test-filters",
    title: i18nKey("Reuse the configured filters"),
    description: i18nKey(
      "Creates a rule from the sample observation filters.",
    ),
  },
  {
    value: "different-scope",
    title: i18nKey("Run on a different scope"),
    description: i18nKey(
      "Attach to a rule you already have, or create a new one.",
    ),
  },
] as const;

export function EvaluatorSavedDialog({
  open,
  mode,
  modeContentByMode,
  backfillContent,
  costSummary,
  canSubmit,
  isSubmitting,
  primaryActionLabel,
  onModeChange,
  onDismiss,
  onSecondaryAction,
  onPrimaryAction,
  onOpenAutoFocus,
  onCloseAnimationEnd,
}: {
  open: boolean;
  mode: EvaluatorSavedMode;
  modeContentByMode: Record<EvaluatorSavedMode, ReactNode>;
  backfillContent: ReactNode;
  costSummary: ReactNode;
  canSubmit: boolean;
  isSubmitting: boolean;
  primaryActionLabel: string;
  onModeChange: (mode: EvaluatorSavedMode) => void;
  onDismiss: () => void;
  onSecondaryAction: () => void;
  onPrimaryAction: () => void;
  onOpenAutoFocus?: () => void;
  onCloseAnimationEnd?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDismiss();
      }}
    >
      <DialogContent
        className="sm:max-w-4xl"
        closeOnInteractionOutside
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAnimationEnd}
      >
        <DialogHeader className="[&>div]:items-start [&>div>button]:-mt-1">
          <DialogTitle>{t("Evaluator saved")}</DialogTitle>
          <DialogDescription>
            {t("Choose which observations this evaluator should score.")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-0 p-0">
          <div className="grid h-[30rem] grid-cols-[minmax(0,1fr)_15rem] overflow-hidden">
            <div className="min-w-0 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
              <h3 className="mb-2 text-sm font-bold">
                {t("Set up rule to run on incoming observations")}
              </h3>
              <RadioGroup
                value={mode}
                onValueChange={(value) =>
                  onModeChange(value as EvaluatorSavedMode)
                }
              >
                {modeOptions.map((option) => {
                  const selected = option.value === mode;
                  const id = `evaluator-saved-mode-${option.value}`;
                  const contentId = `${id}-content`;

                  return (
                    <Collapsible key={option.value} open={selected} asChild>
                      <div
                        className={cn(
                          "min-w-0 rounded-md border p-3 transition-colors duration-200",
                          selected
                            ? "border-foreground bg-background"
                            : "bg-muted/30 hover:bg-muted/50 cursor-pointer",
                        )}
                        onClick={(event) => {
                          if (selected) return;
                          const target = event.target as HTMLElement;
                          if (
                            target.closest(
                              "button, input, label, a, [role='radio']",
                            )
                          ) {
                            return;
                          }
                          onModeChange(option.value);
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <div className="mt-0.5">
                            <RadioGroup.Item
                              id={id}
                              value={option.value}
                              aria-controls={contentId}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <label
                              htmlFor={id}
                              className="block cursor-pointer text-sm leading-none font-bold"
                            >
                              {t(option.title)}
                            </label>
                            <p className="text-muted-foreground mt-1.5 text-xs">
                              {t(option.description)}
                            </p>
                          </div>
                        </div>
                        <CollapsibleContent
                          id={contentId}
                          aria-labelledby={id}
                          className={cn(styles.collapsibleContent, "space-y-3")}
                        >
                          <div className="mt-3 ml-6 min-w-0 pr-1">
                            {modeContentByMode[option.value]}
                          </div>
                          {backfillContent}
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  );
                })}
              </RadioGroup>
            </div>
            <aside
              className={cn(
                "overflow-y-auto px-5 py-5 [scrollbar-gutter:stable]",
                costSummary && "border-l",
              )}
            >
              {costSummary}
            </aside>
          </div>
        </DialogBody>
        <DialogFooter className="px-6 py-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                disabled={isSubmitting}
                onClick={onSecondaryAction}
              >
                {t("Skip execution")}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              {t(
                "It remains available for batch evaluations and prompt experiments. Set up incoming observations later.",
              )}
            </TooltipContent>
          </Tooltip>
          <Button
            disabled={!canSubmit}
            loading={isSubmitting}
            loadingText={t("Starting evaluator...")}
            onClick={onPrimaryAction}
          >
            {primaryActionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
