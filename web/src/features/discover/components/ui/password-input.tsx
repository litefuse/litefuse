// @ts-nocheck
"use client";

import { PasswordInput as SharedPasswordInput } from "@/src/components/ui/password-input";

import { Button } from "./button";

export interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  isConfigured?: boolean;
  onReset?: () => void;
}

export function PasswordInput({
  isConfigured,
  onReset,
  value = "",
  ...props
}: PasswordInputProps) {
  if (isConfigured) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-sm">Configured</span>
        <Button size="sm" variant="secondary" onClick={onReset}>
          Reset
        </Button>
      </div>
    );
  }

  return <SharedPasswordInput {...props} value={value} />;
}

export { PasswordInput as SecretInput };
