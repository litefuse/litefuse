import type { TFunction } from "i18next";
import { type UseFormReturn, type FieldValues } from "react-hook-form";
import {
  type ActionCreate,
  type ActionDomain,
  type ActionType,
  type AutomationDomain,
} from "@langfuse/shared";

export interface BaseActionHandler<
  TFormData extends FieldValues = FieldValues,
> {
  actionType: ActionType;

  // Get default values for this action type
  getDefaultValues(automation?: AutomationDomain): TFormData;

  // Validate the form data for this action type
  // `t` is passed in because handlers are plain classes, not components.
  validateFormData(
    formData: TFormData,
    t: TFunction,
  ): {
    isValid: boolean;
    errors?: string[];
  };

  // Build the action config for API submission
  buildActionConfig(formData: TFormData): ActionCreate;

  // Render the action form UI - using any for form to allow flexibility
  renderForm(props: {
    form: UseFormReturn<any>;
    disabled: boolean;
    projectId: string;
    action?: ActionDomain;
  }): React.ReactNode;
}
