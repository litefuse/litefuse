import { Input } from "@/src/components/ui/input";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/src/components/ui/form";
import { type UseFormReturn } from "react-hook-form";
import { type ActionDomain } from "@langfuse/shared";
import { ExternalLink } from "lucide-react";
import Link from "next/link";

import { Trans, useTranslation } from "react-i18next";
interface GitHubDispatchActionFormProps {
  form: UseFormReturn<any>;
  disabled: boolean;
  projectId: string;
  action?: ActionDomain;
}

export const GitHubDispatchActionForm: React.FC<
  GitHubDispatchActionFormProps
> = ({ form, disabled }) => {
  const { t } = useTranslation();
  const displayGitHubToken = form.watch("githubDispatch.displayGitHubToken");

  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="githubDispatch.url"
        rules={{ required: t("Repository Dispatch URL is required") }}
        render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center">
              {t("Repository Dispatch URL")}{" "}
              <span className="text-destructive ml-1">*</span>
            </FormLabel>
            <FormControl>
              <Input
                placeholder={
                  "https://api.github.com/repos/owner/repo/dispatches"
                }
                disabled={disabled}
                {...field}
              />
            </FormControl>
            <FormDescription>
              {t("GitHub API endpoint for repository dispatch.")}{" "}
              <Link
                href="https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary inline-flex items-center hover:underline"
              >
                {t("Learn more")} <ExternalLink className="ml-1 h-3 w-3" />
              </Link>
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="githubDispatch.eventType"
        rules={{ required: t("Event type is required") }}
        render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center">
              {t("Event Type")} <span className="text-destructive ml-1">*</span>
            </FormLabel>
            <FormControl>
              <Input
                placeholder="prompt-update"
                disabled={disabled}
                {...field}
              />
            </FormControl>
            <FormDescription>
              <Trans
                i18nKey="Event type for GitHub Actions workflow triggers. This will be used in the <0>on.repository_dispatch.types</0> filter in your workflow file."
                components={[<code key="0" className="text-xs" />]}
              />
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="githubDispatch.githubToken"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center">
              {t("GitHub Personal Access Token")}
              {!displayGitHubToken && (
                <span className="text-destructive ml-1">*</span>
              )}
            </FormLabel>
            <FormControl>
              <Input
                type="password"
                placeholder={displayGitHubToken || "ghp_..."}
                disabled={disabled}
                {...field}
              />
            </FormControl>
            <FormDescription>
              <Trans
                i18nKey="GitHub PAT with <0>repo</0> scope for repository dispatch."
                components={[<code key="0" className="text-xs" />]}
              />
              {displayGitHubToken
                ? t(" Leave empty to keep existing token.")
                : ""}{" "}
              <Link
                href="https://github.com/settings/tokens/new?scopes=repo&description=Litefuse%20Automation"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary inline-flex items-center hover:underline"
              >
                {t("Create token")} <ExternalLink className="ml-1 h-3 w-3" />
              </Link>
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
};

// Schema exported for use in automationForm.tsx
export const githubDispatchSchema = {
  url: "",
  eventType: "",
  githubToken: "",
};
