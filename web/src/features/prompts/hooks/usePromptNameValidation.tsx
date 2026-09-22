import { useEffect } from "react";
import { type UseFormReturn } from "react-hook-form";

import { i18nKey } from "@/src/features/i18n/i18nKey";

/**
 * Stored on the field, not shown directly: FormMessage runs t() on it. Keeping
 * the key (rather than the translated text) is what lets the clear-check below
 * recognise its own error in every language.
 */
const DUPLICATE_NAME_MESSAGE = i18nKey("Prompt name already exists.");

interface UsePromptNameValidationProps {
  currentName: string | undefined;
  allPrompts: { value: string }[] | undefined;
  form: UseFormReturn<any>;
}

export const usePromptNameValidation = ({
  currentName,
  allPrompts,
  form,
}: UsePromptNameValidationProps) => {
  useEffect(() => {
    if (!currentName || !allPrompts) return;

    const isNewPrompt = !allPrompts
      ?.map((prompt) => prompt.value)
      .includes(currentName);

    if (!isNewPrompt) {
      form.setError("name", { message: DUPLICATE_NAME_MESSAGE });
    } else {
      const currentError = form.getFieldState("name").error;
      if (currentError?.message === DUPLICATE_NAME_MESSAGE) {
        form.clearErrors("name");
      }
    }
  }, [currentName, allPrompts, form]);
};
