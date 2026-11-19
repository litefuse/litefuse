import type { TFunction } from "i18next";
import React from "react";
import { type UseFormReturn } from "react-hook-form";
import { type BaseActionHandler } from "./BaseActionHandler";
import { WebhookActionForm, formatWebhookHeaders } from "./WebhookActionForm";
import {
  type AutomationDomain,
  AvailableWebhookApiSchema,
  WebhookDefaultHeaders,
  type ActionCreate,
  type ActionDomain,
} from "@langfuse/shared";
import { z } from "zod/v4";

// Define the form schema for webhook actions
// Exported to silence @typescript-eslint/no-unused-vars v8 warning
// (used for type extraction via z.infer<typeof>, which is a legitimate pattern)
export const WebhookActionFormSchema = z.object({
  webhook: z.object({
    url: z.string().url("Invalid URL"),
    headers: z
      .array(
        z.object({
          name: z.string(),
          value: z.string(),
          displayValue: z.string(),
          isSecret: z.boolean(),
          wasSecret: z.boolean(),
        }),
      )
      .default([]),
    apiVersion: AvailableWebhookApiSchema.default({ prompt: "v1" }),
  }),
});

type WebhookActionFormData = z.infer<typeof WebhookActionFormSchema>;

// Define a type for header pairs
type HeaderPair = {
  name: string;
  value: string;
  displayValue: string;
  isSecret: boolean;
  wasSecret: boolean;
};

export class WebhookActionHandler
  implements BaseActionHandler<WebhookActionFormData>
{
  actionType = "WEBHOOK" as const;

  // Parse existing headers if available
  private parseHeaders(automation?: AutomationDomain): HeaderPair[] {
    if (
      automation?.action?.type === "WEBHOOK" &&
      automation?.action?.config &&
      "displayHeaders" in automation.action.config &&
      automation.action.config.displayHeaders
    ) {
      try {
        const displayHeaders = automation.action.config.displayHeaders;

        return Object.entries(displayHeaders).map(([name, headerObj]) => ({
          name,
          value: headerObj.secret ? "" : headerObj.value,
          displayValue: headerObj.value,
          isSecret: headerObj.secret,
          wasSecret: headerObj.secret,
        }));
      } catch (e) {
        console.error("Failed to parse headers:", e);
        return [];
      }
    }
    return [];
  }

  getDefaultValues(automation?: AutomationDomain): WebhookActionFormData {
    // Extract apiVersion from existing config
    let apiVersion = { prompt: "v1" } as const;
    if (
      automation?.action?.type === "WEBHOOK" &&
      automation?.action?.config &&
      "apiVersion" in automation.action.config &&
      automation.action.config.apiVersion
    ) {
      apiVersion = automation.action.config.apiVersion;
    }

    return {
      webhook: {
        url:
          (automation?.action?.type === "WEBHOOK" &&
            automation?.action?.config &&
            "url" in automation.action.config &&
            automation.action.config.url) ||
          "",
        headers: this.parseHeaders(automation),
        apiVersion,
      },
    };
  }

  validateFormData(
    formData: WebhookActionFormData,
    t: TFunction,
  ): {
    isValid: boolean;
    errors?: string[];
  } {
    const errors: string[] = [];

    if (!formData.webhook?.url) {
      errors.push(t("Webhook URL is required"));
    }

    // Validate headers
    if (formData.webhook?.headers) {
      const defaultHeaderKeys = Object.keys(WebhookDefaultHeaders);

      formData.webhook.headers.forEach((header: HeaderPair, index: number) => {
        // Only validate non-empty headers
        if (header.name.trim() || header.value.trim()) {
          if (!header.name.trim()) {
            errors.push(
              t("Header {{index}}: Name cannot be empty", { index: index + 1 }),
            );
          }
          if (!header.value.trim() && !header.isSecret) {
            errors.push(
              t("Header {{index}}: Value cannot be empty", {
                index: index + 1,
              }),
            );
          }
          if (header.wasSecret !== header.isSecret && !header.value.trim()) {
            errors.push(
              t(
                "Header {{index}}: A value must be provided when making a header {{visibility}}",
                {
                  index: index + 1,
                  visibility: header.wasSecret ? t("public") : t("secret"),
                },
              ),
            );
          }

          // Check if header name conflicts with default headers
          if (
            header.name.trim() &&
            defaultHeaderKeys.includes(header.name.trim().toLowerCase())
          ) {
            errors.push(
              t(
                'Header {{index}}: "{{name}}" is automatically added by Litefuse and cannot be customized',
                { index: index + 1, name: header.name },
              ),
            );
          }
        }
      });

      // check if header name is already in the form
      // Check for duplicate header names (case-insensitive)
      const headerNames = formData.webhook.headers
        .filter((h) => h.name.trim()) // Only check non-empty header names
        .map((h) => h.name.trim().toLowerCase());

      const uniqueHeaderNames = new Set(headerNames);
      if (uniqueHeaderNames.size < headerNames.length) {
        errors.push(
          "Duplicate header names are not allowed (case-insensitive)",
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  buildActionConfig(formData: WebhookActionFormData): ActionCreate {
    // Convert headers array to requestHeaders format
    let headersObject: Record<string, { secret: boolean; value: string }> = {};

    if (formData.webhook?.headers) {
      headersObject = formatWebhookHeaders(formData.webhook.headers);
    }

    return {
      type: "WEBHOOK",
      url: formData.webhook?.url || "",
      requestHeaders: headersObject,
      apiVersion: formData.webhook?.apiVersion || { prompt: "v1" },
    };
  }

  renderForm(props: {
    form: UseFormReturn<WebhookActionFormData>;
    disabled: boolean;
    projectId: string;
    action?: ActionDomain;
  }) {
    return (
      <WebhookActionForm
        form={props.form}
        disabled={props.disabled}
        projectId={props.projectId}
        action={props.action}
      />
    );
  }
}
