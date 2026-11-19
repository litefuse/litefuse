import React, { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { Button } from "@/src/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { Separator } from "@/src/components/ui/separator";
import { Switch } from "@/src/components/ui/switch";
import { useRouter } from "next/router";
import { z } from "zod/v4";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/src/components/ui/form";
import { api } from "@/src/utils/api";
import {
  type AutomationDomain,
  type ActionTypes,
  type JobConfigState,
  webhookActionFilterOptions,
} from "@langfuse/shared";
import { InlineFilterBuilder } from "@/src/features/filters/components/filter-builder";
import { DeleteAutomationButton } from "./DeleteAutomationButton";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { showSuccessToast } from "@/src/features/notifications/showSuccessToast";
import { showErrorToast } from "@/src/features/notifications/showErrorToast";
import { ActionHandlerRegistry } from "./actions";
import { webhookSchema } from "./actions/WebhookActionForm";
import { MultiSelect } from "@/src/features/filters/components/multi-select";

import { useTranslation } from "react-i18next";
// Define Slack action schema
const slackSchema = z.object({
  channelId: z.string().min(1, "Channel is required"),
  channelName: z.string().min(1, "Channel name is required"),
  messageTemplate: z.string().optional(),
});

// Define GitHub Dispatch action schema
const githubDispatchSchema = z.object({
  url: z.string().url("Invalid URL"),
  eventType: z.string().min(1, "Event type is required").max(100),
  githubToken: z.string(),
  displayGitHubToken: z.string().optional(),
});

// Define the TriggerEventSource enum directly in this file to match the backend
enum TriggerEventSource {
  Prompt = "prompt",
}

// Define schemas for form validation
const baseFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  eventSource: z.string().min(1, "Event source is required"),
  eventAction: z
    .array(z.string())
    .min(1, "At least one event action is required"),
  status: z.enum(["ACTIVE", "INACTIVE"]),
  filter: z.array(z.any()).optional(),
});

const formSchema = z.discriminatedUnion("actionType", [
  baseFormSchema.extend({
    actionType: z.literal("WEBHOOK"),
    webhook: webhookSchema,
  }),
  baseFormSchema.extend({
    actionType: z.literal("SLACK"),
    slack: slackSchema,
  }),
  baseFormSchema.extend({
    actionType: z.literal("GITHUB_DISPATCH"),
    githubDispatch: githubDispatchSchema,
  }),
]);

type FormValues = z.infer<typeof formSchema>;

interface AutomationFormProps {
  projectId: string;
  onSuccess?: (
    automationId?: string,
    webhookSecret?: string,
    actionType?: "WEBHOOK" | "GITHUB_DISPATCH",
  ) => void;
  onCancel?: () => void;
  automation?: AutomationDomain;
  isEditing?: boolean;
}

export const AutomationForm = ({
  projectId,
  onSuccess,
  onCancel,
  automation,
  isEditing = false,
}: AutomationFormProps) => {
  const { t } = useTranslation();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<string>("webhook");
  const hasAccess = useHasProjectAccess({
    projectId,
    scope: "automations:CUD",
  });

  const utils = api.useUtils();

  // Set up mutations
  const createAutomationMutation = api.automations.createAutomation.useMutation(
    {
      onSuccess: async () => {
        // Invalidate automations queries
        await utils.automations.invalidate();
      },
    },
  );
  const updateAutomationMutation = api.automations.updateAutomation.useMutation(
    {
      onSuccess: async () => {
        // Invalidate automations queries
        await utils.automations.invalidate();
      },
    },
  );

  // Get the action type for the form when editing
  const getActionType = () => {
    if (automation?.action?.type) {
      return automation.action.type as ActionTypes;
    }
    return "WEBHOOK";
  };

  // Get default values based on action type
  const getDefaultValues = (): FormValues => {
    const actionType = getActionType();
    const today = new Date().toLocaleString("sv").split("T")[0]; // YYYY-MM-DD

    const baseValues = {
      name:
        isEditing && automation ? automation.name : `${actionType} ${today}`,
      eventSource: automation
        ? automation.trigger.eventSource
        : TriggerEventSource.Prompt,
      eventAction: automation
        ? automation.trigger.eventActions
        : ["created", "updated", "deleted"],
      status: (isEditing && automation
        ? automation.trigger.status
        : "ACTIVE") as "ACTIVE" | "INACTIVE",
      filter: automation ? automation.trigger.filter || [] : [],
    };

    if (actionType === "WEBHOOK") {
      // Use action handler to get default values with proper typing
      const handler = ActionHandlerRegistry.getHandler("WEBHOOK");
      const webhookDefaults = handler.getDefaultValues(automation);
      return {
        ...baseValues,
        actionType: "WEBHOOK" as const,
        eventSource: TriggerEventSource.Prompt,
        webhook: {
          url: webhookDefaults.webhook.url || "",
          headers: webhookDefaults.webhook.headers || [],
          apiVersion: webhookDefaults.webhook.apiVersion || {
            prompt: "v1" as const,
          },
        },
      };
    } else if (actionType === "SLACK") {
      // Use action handler to get default values with proper typing
      const handler = ActionHandlerRegistry.getHandler("SLACK");
      const slackDefaults = handler.getDefaultValues(automation);
      return {
        ...baseValues,
        actionType: "SLACK" as const,
        eventSource: TriggerEventSource.Prompt,
        slack: {
          channelId: slackDefaults.slack.channelId || "",
          channelName: slackDefaults.slack.channelName || "",
          messageTemplate: slackDefaults.slack.messageTemplate || "",
        },
      };
    } else if (actionType === "GITHUB_DISPATCH") {
      // Use action handler to get default values with proper typing
      const handler = ActionHandlerRegistry.getHandler("GITHUB_DISPATCH");
      const githubDefaults = handler.getDefaultValues(automation);
      return {
        ...baseValues,
        actionType: "GITHUB_DISPATCH" as const,
        eventSource: TriggerEventSource.Prompt,
        githubDispatch: {
          url: githubDefaults.githubDispatch.url || "",
          eventType: githubDefaults.githubDispatch.eventType || "",
          githubToken: githubDefaults.githubDispatch.githubToken || "",
          displayGitHubToken:
            githubDefaults.githubDispatch.displayGitHubToken || undefined,
        },
      };
    } else {
      throw new Error("Invalid action type");
    }
  };

  // Initialize form with default values or values from existing automation
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: getDefaultValues(),
  });

  // Set the active tab based on the action type
  useEffect(() => {
    if (isEditing && automation?.action?.type) {
      setActiveTab(automation.action.type.toLowerCase());
    }
  }, [isEditing, automation]);

  // Handle form submission
  const onSubmit = async (data: FormValues) => {
    if (!hasAccess) {
      showErrorToast(
        t("Permission Denied"),
        t("You don't have permission to modify automations."),
      );
      return;
    }

    // Use action handler to validate and build config
    const handler = ActionHandlerRegistry.getHandler(data.actionType);
    const validation = handler.validateFormData(data, t);

    if (!validation.isValid) {
      showErrorToast(
        t("Validation Error"),
        validation.errors?.join(", ") ||
          t("Please fill in all required fields"),
      );
      return;
    }

    const actionConfig = handler.buildActionConfig(data);

    if (isEditing && automation) {
      // Update existing automation
      await updateAutomationMutation.mutateAsync({
        projectId,
        automationId: automation.id,
        name: data.name,
        eventSource: data.eventSource,
        eventAction: data.eventAction,
        filter: data.filter && data.filter.length > 0 ? data.filter : null,
        status: data.status as JobConfigState,
        actionType: data.actionType,
        actionConfig: actionConfig,
      });

      showSuccessToast({
        title: t("Automation Updated"),
        description: t('Successfully updated automation "{{name}}".', {
          name: data.name,
        }),
      });

      onSuccess?.(automation.id);
    } else {
      // Create new automation
      const result = await createAutomationMutation.mutateAsync({
        projectId,
        name: data.name,
        eventSource: data.eventSource,
        eventAction: data.eventAction,
        filter: data.filter && data.filter.length > 0 ? data.filter : null,
        status: data.status as JobConfigState,
        actionType: data.actionType,
        actionConfig: actionConfig,
      });

      showSuccessToast({
        title: t("Automation Created"),
        description: t('Successfully created automation "{{name}}".', {
          name: data.name,
        }),
      });

      onSuccess?.(
        result.automation.id,
        result.webhookSecret,
        data.actionType as "WEBHOOK" | "GITHUB_DISPATCH",
      );
    }
  };

  // Update button text based on if we're editing an existing automation
  const submitButtonText =
    isEditing && automation ? t("Update Automation") : t("Save Automation");

  // Update required fields based on action type
  const handleActionTypeChange = (value: ActionTypes) => {
    setActiveTab(value.toLowerCase());
    form.setValue("actionType", value);

    if (value === "WEBHOOK") {
      const handler = ActionHandlerRegistry.getHandler("WEBHOOK");
      const defaultValues = handler.getDefaultValues();
      form.setValue("webhook", defaultValues.webhook);
    } else if (value === "SLACK") {
      const handler = ActionHandlerRegistry.getHandler("SLACK");
      const defaultValues = handler.getDefaultValues();
      form.setValue("slack", defaultValues.slack);
    } else if (value === "GITHUB_DISPATCH") {
      const handler = ActionHandlerRegistry.getHandler("GITHUB_DISPATCH");
      const defaultValues = handler.getDefaultValues();
      form.setValue("githubDispatch", defaultValues.githubDispatch);
    }

    // If we are creating a new automation, update the default name
    if (!automation) {
      const today = new Date().toLocaleString("sv").split("T")[0];
      form.setValue("name", `${value} ${today}`);
    }
  };

  // Handle cancel button click
  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    } else {
      router.push(`/project/${projectId}/settings/automations`);
    }
  };

  // Get current action handler for rendering
  const getCurrentActionHandler = () => {
    try {
      const actionType = form.watch("actionType");
      return ActionHandlerRegistry.getHandler(actionType);
    } catch (error) {
      console.error("Failed to get action handler:", error);
      return null;
    }
  };

  const currentActionHandler = getCurrentActionHandler();

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {isEditing && (
          <div className="mb-6 flex items-center gap-4">
            <div className="flex-1">
              <FormField
                control={form.control}
                name="name"
                rules={{ required: t("Name is required") }}
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input
                        placeholder={t("Automation name")}
                        {...field}
                        disabled={!hasAccess || !isEditing}
                        className="border-border rounded-none border-0 border-b bg-transparent px-0 text-2xl font-semibold focus-visible:ring-0 focus-visible:ring-offset-0"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center gap-2">
                  <FormLabel className="text-sm font-medium">
                    {t("Active")}
                  </FormLabel>
                  <FormControl>
                    <Switch
                      checked={field.value === "ACTIVE"}
                      onCheckedChange={(checked) =>
                        field.onChange(checked ? "ACTIVE" : "INACTIVE")
                      }
                      disabled={!hasAccess || !isEditing}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t("Trigger")}</CardTitle>
            <CardDescription>
              {t("Configure when this automation should run.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="eventSource"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("Event Source")}</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={!hasAccess || !isEditing}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue
                          placeholder={t("Select an event source")}
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={TriggerEventSource.Prompt}>
                        {t("Prompt")}
                      </SelectItem>
                      <SelectItem disabled={true} value="planned">
                        {t("More coming soon...")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t("The event that triggers this automation.")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="eventAction"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("Event Action")}</FormLabel>
                  <FormControl>
                    <MultiSelect
                      title={t("Event Actions")}
                      label={t("Actions")}
                      values={field.value}
                      onValueChange={field.onChange}
                      options={[
                        {
                          // The value travels in the webhook payload, so only
                          // the label is translated.
                          value: "created",
                          displayValue: t("created"),
                          description: t(
                            "Whenever a new prompt version is created",
                          ),
                        },
                        {
                          value: "updated",
                          displayValue: t("updated"),
                          description: t(
                            "Whenever tags or labels on a prompt version are updated",
                          ),
                        },
                        {
                          value: "deleted",
                          displayValue: t("deleted"),
                          description: t(
                            "Whenever a prompt version is deleted",
                          ),
                        },
                      ]}
                      className="my-0 w-auto overflow-hidden"
                      disabled={!hasAccess || !isEditing}
                      labelTruncateCutOff={4}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      "The actions on the event source that trigger this automation.",
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="filter"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("Filter")}</FormLabel>
                  <FormControl>
                    <InlineFilterBuilder
                      columns={webhookActionFilterOptions()}
                      filterState={field.value || []}
                      onChange={field.onChange}
                      disabled={
                        activeTab === "annotation_queue" ||
                        !hasAccess ||
                        !isEditing
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      "Add conditions to narrow down when this trigger fires.",
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("Action")}</CardTitle>
            <CardDescription>
              {t("Configure what happens when the trigger fires.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="actionType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("Action Type")}</FormLabel>
                  <Select
                    onValueChange={handleActionTypeChange}
                    value={field.value}
                    disabled={!hasAccess || !isEditing}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t("Select an action type")} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ActionHandlerRegistry.getAllActionTypes().map(
                        (actionType) => (
                          <SelectItem key={actionType} value={actionType}>
                            {actionType === "WEBHOOK"
                              ? t("Webhook")
                              : actionType === "SLACK"
                                ? t("Slack")
                                : actionType === "GITHUB_DISPATCH"
                                  ? t("GitHub Dispatch")
                                  : t("Annotation Queue")}
                          </SelectItem>
                        ),
                      )}
                      <SelectItem disabled={true} value="planned">
                        {t("More coming soon...")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t("The type of action to perform when the trigger fires.")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator className="my-4" />

            {currentActionHandler &&
              currentActionHandler.renderForm({
                form,
                disabled: !hasAccess || !isEditing,
                projectId,
                action: automation?.action,
              })}
          </CardContent>
        </Card>

        {isEditing && (
          <div className="flex justify-between gap-3">
            {isEditing && automation?.trigger.id && automation?.action.id && (
              <div>
                <DeleteAutomationButton
                  projectId={projectId}
                  automationId={automation.id}
                  variant="button"
                  onSuccess={() => {
                    utils.automations.invalidate();
                    router.push(`/project/${projectId}/settings/automations`);
                  }}
                />
              </div>
            )}
            <div className="grow"></div>
            <div className="flex gap-3">
              <Button type="button" variant="outline" onClick={handleCancel}>
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                disabled={!hasAccess || form.formState.isSubmitting}
              >
                {submitButtonText}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Form>
  );
};
