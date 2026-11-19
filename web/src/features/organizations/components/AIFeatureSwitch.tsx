import { Button } from "@/src/components/ui/button";
import { Switch } from "@/src/components/ui/switch";
import { api } from "@/src/utils/api";
import { useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/src/components/ui/dialog";
import Header from "@/src/components/layouts/header";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";
import { useHasOrganizationAccess } from "@/src/features/rbac/utils/checkOrganizationAccess";
import {
  useLangfuseCloudRegion,
  useQueryOrganization,
} from "@/src/features/organizations/hooks";
import { Card } from "@/src/components/ui/card";
import { LockIcon, ExternalLink } from "lucide-react";
import { useSession } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod/v4";

import { Trans, useTranslation } from "react-i18next";
const aiFeaturesSchema = z.object({
  aiFeaturesEnabled: z.boolean(),
});

export default function AIFeatureSwitch() {
  const { t } = useTranslation();
  const { update: updateSession } = useSession();
  const { isLangfuseCloud } = useLangfuseCloudRegion();
  const capture = usePostHogClientCapture();
  const organization = useQueryOrganization();
  const [isAIFeatureSwitchEnabled, setIsAIFeatureSwitchEnabled] = useState(
    organization?.aiFeaturesEnabled ?? false,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const hasAccess = useHasOrganizationAccess({
    organizationId: organization?.id,
    scope: "organization:update",
  });

  const confirmForm = useForm<z.infer<typeof aiFeaturesSchema>>({
    resolver: zodResolver(aiFeaturesSchema),
    defaultValues: {
      aiFeaturesEnabled: isAIFeatureSwitchEnabled,
    },
  });

  const updateAIFeatures = api.organizations.update.useMutation({
    onSuccess: () => {
      void updateSession();
      setConfirmOpen(false);
    },
    onError: () => {
      setConfirmOpen(false);
    },
  });

  function handleSwitchChange(newValue: boolean) {
    if (!hasAccess) return;
    setIsAIFeatureSwitchEnabled(newValue);
    confirmForm.setValue("aiFeaturesEnabled", newValue);
    setConfirmOpen(true);
  }

  function handleCancel() {
    setIsAIFeatureSwitchEnabled(organization?.aiFeaturesEnabled ?? false);
    setConfirmOpen(false);
  }

  function handleConfirm() {
    if (!organization || !hasAccess) return;
    capture("organization_settings:ai_features_toggle");
    updateAIFeatures.mutate({
      orgId: organization.id,
      aiFeaturesEnabled: isAIFeatureSwitchEnabled,
    });
  }

  if (!isLangfuseCloud) return null;

  return (
    <div>
      <Header title={t("AI Features")} />
      <Card className="mb-4 p-3">
        <div className="flex flex-row items-center justify-between">
          <div className="flex flex-col gap-1">
            <h4 className="font-semibold">
              {t("Enable AI powered features for your organization")}
            </h4>
            <p className="text-sm">
              <Trans
                i18nKey="This setting applies to all users and projects. Any data <0>can</0> be sent to AWS Bedrock within the Litefuse data region. Traces are sent to Litefuse Cloud in your data region. Your data will not be used for training models. Applicable HIPAA, SOC2, GDPR, and ISO 27001 compliance remains intact."
                components={[<i key="0" />]}
              />{" "}
              <a
                href="https://litefuse.ai/security/ai-features"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary inline-flex items-center gap-1 hover:underline"
              >
                {t("More details in the docs here.")}
                <ExternalLink className="h-3 w-3" />
              </a>
            </p>
          </div>
          <div className="relative">
            <Switch
              checked={isAIFeatureSwitchEnabled}
              onCheckedChange={handleSwitchChange}
              disabled={!hasAccess}
            />
            {!hasAccess && (
              <span title={t("No access")}>
                <LockIcon className="text-muted absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 transform" />
              </span>
            )}
          </div>
        </div>
      </Card>

      <Dialog
        open={confirmOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen && !updateAIFeatures.isPending) {
            handleCancel();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Confirm AI Features Change")}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <span className="text-sm">
              <Trans
                i18nKey="You are about to <0>{{action}}</0> AI features for your organization. When enabled, any data <1>can</1> be sent to AWS Bedrock in your data region for processing."
                values={{
                  action: isAIFeatureSwitchEnabled ? t("enable") : t("disable"),
                }}
                components={[<strong key="0" />, <i key="1" />]}
              />
              <br />
              <br />{" "}
              <a
                href="https://litefuse.ai/security/ai-features"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary inline-flex items-center gap-1 hover:underline"
              >
                {t("Learn more in the docs.")}
                <ExternalLink className="h-3 w-3" />
              </a>
            </span>
            <p className="text-muted-foreground mt-3 text-sm">
              {t("Are you sure you want to proceed?")}
            </p>
          </DialogBody>
          <DialogFooter>
            <div className="flex justify-end space-x-2">
              <Button
                type="button"
                variant="outline"
                disabled={updateAIFeatures.isPending}
                onClick={handleCancel}
              >
                {t("Cancel")}
              </Button>
              <Button
                type="submit"
                onClick={handleConfirm}
                loading={updateAIFeatures.isPending}
              >
                {t("Confirm")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
