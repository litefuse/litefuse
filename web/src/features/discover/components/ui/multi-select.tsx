// @ts-nocheck
"use client";

import { Check, X } from "lucide-react";

import { cn } from "@/src/utils/tailwind";

import type { SelectOption } from "./select";

export interface ActionMeta<T = any> {
  action: string;
  option?: SelectOption<T>;
  removedValues?: SelectOption<T>[];
}

interface MultiSelectProps<T = any> {
  options?: SelectOption<T>[];
  value?: SelectOption<T>[];
  onChange?: (values: SelectOption<T>[], actionMeta: ActionMeta<T>) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function MultiSelect<T = any>({
  options = [],
  value = [],
  onChange,
  placeholder = "Select...",
  disabled,
  className,
}: MultiSelectProps<T>) {
  const toggleOption = (option: SelectOption<T>) => {
    const isSelected = value.some(
      (selectedValue) => selectedValue.value === option.value,
    );
    const nextValues = isSelected
      ? value.filter((selectedValue) => selectedValue.value !== option.value)
      : [...value, option];

    onChange?.(nextValues, {
      action: isSelected ? "deselect-option" : "select-option",
      option,
    });
  };

  return (
    <div
      className={cn(
        "border-border bg-background relative min-h-8 w-full rounded border px-2 text-sm",
        className,
      )}
    >
      <div className="flex flex-wrap gap-1 py-1">
        {value.map((selectedValue, index) => (
          <span
            key={index}
            className="bg-primary/10 text-primary flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs"
          >
            {selectedValue.label ?? String(selectedValue.value)}
            <button
              type="button"
              onClick={() => toggleOption(selectedValue)}
              className="hover:text-destructive ml-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {value.length === 0 ? (
          <span className="text-muted-foreground">{placeholder}</span>
        ) : null}
      </div>
      <div className="border-border mt-1 max-h-40 overflow-auto border-t">
        {options.map((option, index) => {
          const isSelected = value.some(
            (selectedValue) => selectedValue.value === option.value,
          );

          return (
            <div
              key={index}
              onClick={() => {
                if (!disabled) {
                  toggleOption(option);
                }
              }}
              className={cn(
                "hover:bg-accent flex cursor-default items-center gap-2 px-2 py-1",
                isSelected && "bg-accent/50",
                disabled && "pointer-events-none opacity-50",
              )}
            >
              {isSelected ? <Check className="h-3 w-3" /> : null}
              <span>{option.label ?? String(option.value)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
