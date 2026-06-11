// @ts-nocheck
"use client";

import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/src/utils/tailwind";

interface FieldProps {
  label?: ReactNode;
  description?: ReactNode;
  invalid?: boolean;
  error?: string;
  children?: ReactNode;
  className?: string;
  horizontal?: boolean;
  style?: CSSProperties;
}

export function Field({
  label,
  description,
  invalid,
  error,
  children,
  className,
  horizontal,
  style,
}: FieldProps) {
  return (
    <div
      className={cn(
        "mb-2 flex",
        horizontal ? "flex-row items-center gap-2" : "flex-col gap-1",
        className,
      )}
      style={style}
    >
      {label ? (
        <label className="text-foreground text-xs font-medium">{label}</label>
      ) : null}
      {description ? (
        <p className="text-muted-foreground text-xs">{description}</p>
      ) : null}
      {children}
      {invalid && error ? (
        <p className="text-destructive text-xs">{error}</p>
      ) : null}
    </div>
  );
}

export function FieldSet({
  label,
  children,
  className,
}: {
  label?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <fieldset
      className={cn("border-border mb-4 rounded border p-4", className)}
    >
      {label ? (
        <legend className="text-foreground px-1 text-sm font-medium">
          {label}
        </legend>
      ) : null}
      {children}
    </fieldset>
  );
}

export function InlineField({
  label,
  children,
  className,
}: {
  label?: ReactNode;
  grow?: boolean;
  transparent?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {label ? (
        <label className="text-muted-foreground text-xs whitespace-nowrap">
          {label}
        </label>
      ) : null}
      {children}
    </div>
  );
}

export function InlineFieldRow({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {children}
    </div>
  );
}

export function InlineSwitch({
  value,
  onChange,
  label,
  disabled,
}: {
  value?: boolean;
  onChange?: (event: React.FormEvent<HTMLInputElement>) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={!!value}
        onChange={onChange}
        disabled={disabled}
        className="accent-primary h-4 w-4 rounded"
      />
      {label}
    </label>
  );
}
