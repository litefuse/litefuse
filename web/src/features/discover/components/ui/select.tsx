// @ts-nocheck
"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/src/utils/tailwind";

export interface SelectOption<T = any> {
  label?: string;
  value?: T;
  description?: string;
  imgUrl?: string;
  icon?: string;
  isDisabled?: boolean;
  [key: string]: any;
}

interface SelectProps<T = any> {
  options?: SelectOption<T>[];
  value?: SelectOption<T> | T | null;
  onChange?: (value: SelectOption<T>) => void;
  placeholder?: string;
  isLoading?: boolean;
  disabled?: boolean;
  width?: number | string;
  className?: string;
}

function resolveWidth(width?: number | string) {
  if (width === undefined) {
    return undefined;
  }

  return typeof width === "number" ? `${width}rem` : width;
}

export function Select<T = any>({
  options = [],
  value,
  onChange,
  placeholder = "Select...",
  isLoading,
  disabled,
  width,
  className,
}: SelectProps<T>) {
  const currentValue =
    value !== null && value !== undefined
      ? typeof value === "object" &&
        "value" in (value as Record<string, unknown>)
        ? (value as SelectOption<T>)
        : (options.find((option) => option.value === value) ?? {
            label: String(value),
            value: value as T,
          })
      : null;

  const handleValueChange = (rawValue: string) => {
    const option = options.find(
      (candidate) => String(candidate.value) === rawValue,
    );
    if (option) {
      onChange?.(option);
    }
  };

  return (
    <SelectPrimitive.Root
      value={currentValue ? String(currentValue.value) : undefined}
      onValueChange={handleValueChange}
      disabled={disabled || isLoading}
    >
      <SelectPrimitive.Trigger
        className={cn(
          "border-border bg-background text-foreground focus:ring-ring inline-flex h-8 w-full min-w-30 items-center justify-between rounded border px-2 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        style={{ width: resolveWidth(width) }}
      >
        <SelectPrimitive.Value placeholder={placeholder}>
          {currentValue?.label ?? String(currentValue?.value ?? "")}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="border-border bg-popover z-50 max-h-60 min-w-(--radix-select-trigger-width) overflow-auto rounded border text-sm shadow-md"
          position="popper"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option, index) => (
              <SelectPrimitive.Item
                key={index}
                value={String(option.value)}
                disabled={option.isDisabled}
                className="text-popover-foreground data-highlighted:bg-accent relative flex cursor-default items-center rounded px-2 py-1.5 outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50"
              >
                <SelectPrimitive.ItemText>
                  {option.label ?? String(option.value)}
                </SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2">
                  <Check className="h-3 w-3" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
