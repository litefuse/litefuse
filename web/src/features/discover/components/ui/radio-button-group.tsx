// @ts-nocheck
"use client";

import { cn } from "@/src/utils/tailwind";

export function RadioButtonGroup<T = any>({
  options,
  value,
  onChange,
  disabled,
  disabledOptions,
  className,
}: {
  options: Array<{ label: string; value: T; description?: string }>;
  value?: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
  disabledOptions?: T[];
  className?: string;
}) {
  return (
    <div className={cn("border-border inline-flex rounded border", className)}>
      {options.map((option, index) => {
        const isActive = option.value === value;

        return (
          <button
            key={index}
            type="button"
            disabled={disabled || disabledOptions?.includes(option.value)}
            title={option.description}
            onClick={() => onChange?.(option.value)}
            className={cn(
              "border-border h-7 cursor-pointer border-r px-3 text-xs transition-colors last:border-r-0 disabled:opacity-50",
              isActive
                ? "bg-primary text-primary-foreground"
                : "bg-background text-foreground hover:bg-muted",
              index === 0 && "rounded-l",
              index === options.length - 1 && "rounded-r",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
