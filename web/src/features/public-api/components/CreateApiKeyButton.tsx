import { i18nKey } from "@/src/features/i18n/i18nKey";
import { Button } from "@/src/components/ui/button";
import { api } from "@/src/utils/api";
import { useState } from "react";
import { PlusIcon } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/src/components/ui/dialog";
import { CodeView } from "@/src/components/ui/CodeJsonViewer";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { useHasOrganizationAccess } from "@/src/features/rbac/utils/checkOrganizationAccess";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";
import { Input } from "@/src/components/ui/input";
import { useLangfuseEnvCode } from "@/src/features/public-api/hooks/useLangfuseEnvCode";
import { Label } from "@/src/components/ui/label";
import { cn } from "@/src/utils/tailwind";
import { SubHeader } from "@/src/components/layouts/header";

import { useTranslation } from "react-i18next";
type ApiKeyScope = "project" | "organization";

/** The scope is a permission identifier; these are the words shown for it. */
const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  project: i18nKey("project"),
  organization: i18nKey("organization"),
};

export function CreateApiKeyButton(props: {
  entityId: string;
  scope: ApiKeyScope;
}) {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const capture = usePostHogClientCapture();

  const hasProjectAccess = useHasProjectAccess({
    projectId: props.entityId,
    scope: "apiKeys:CUD",
  });
  const hasOrganizationAccess = useHasOrganizationAccess({
    organizationId: props.entityId,
    scope: "organization:CRUD_apiKeys",
  });

  const hasAccess =
    props.scope === "project" ? hasProjectAccess : hasOrganizationAccess;

  const mutCreateProjectApiKey = api.projectApiKeys.create.useMutation({
    onSuccess: () => utils.projectApiKeys.invalidate(),
  });
  const mutCreateOrgApiKey = api.organizationApiKeys.create.useMutation({
    onSuccess: () => utils.organizationApiKeys.invalidate(),
  });

  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [generatedKeys, setGeneratedKeys] = useState<{
    secretKey: string;
    publicKey: string;
  } | null>(null);

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      // Reset state when closing
      setGeneratedKeys(null);
      setNote("");
    }
  };

  const createApiKey = () => {
    if (props.scope === "project") {
      mutCreateProjectApiKey
        .mutateAsync({
          projectId: props.entityId,
          note: note || undefined,
        })
        .then(({ secretKey, publicKey }) => {
          setGeneratedKeys({
            secretKey,
            publicKey,
          });
          capture(`${props.scope}_settings:api_key_create`);
        })
        .catch((error) => {
          console.error(error);
        });
    } else {
      mutCreateOrgApiKey
        .mutateAsync({
          orgId: props.entityId,
          note: note || undefined,
        })
        .then(({ secretKey, publicKey }) => {
          setGeneratedKeys({
            secretKey,
            publicKey,
          });
          capture(`${props.scope}_settings:api_key_create`);
        })
        .catch((error) => {
          console.error(error);
        });
    }
  };

  if (!hasAccess) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <PlusIcon className="mr-1.5 -ml-0.5 h-5 w-5" aria-hidden="true" />
          {t("Create new API keys")}
        </Button>
      </DialogTrigger>
      <DialogContent onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            {generatedKeys ? t("API Keys") : t("Create API Keys")}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          {generatedKeys ? (
            <ApiKeyRender scope={props.scope} generatedKeys={generatedKeys} />
          ) : (
            <div className="space-y-4">
              <div>
                <Label htmlFor="note">{t("Note (optional)")}</Label>
                <Input
                  id="note"
                  placeholder={t("Production key")}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      createApiKey();
                    }
                  }}
                  className="mt-1.5"
                />
              </div>
            </div>
          )}
        </DialogBody>
        {!generatedKeys && (
          <DialogFooter>
            <Button
              onClick={createApiKey}
              loading={
                mutCreateProjectApiKey.isPending || mutCreateOrgApiKey.isPending
              }
            >
              {t("Create API keys")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export const ApiKeyRender = ({
  scope,
  generatedKeys,
  className,
}: {
  scope: ApiKeyScope;
  generatedKeys?: { secretKey: string; publicKey: string };
  className?: string;
}) => {
  const { t } = useTranslation();
  const envCode = useLangfuseEnvCode(generatedKeys);

  return (
    <div className={cn("space-y-6", className)}>
      <div>
        <SubHeader title={t("Secret Key")} />
        <div className="text-muted-foreground text-sm">
          {t(
            "This key can only be viewed once. You can always create new keys in the {{scope}} settings.",
            { scope: t(API_KEY_SCOPE_LABELS[scope]) },
          )}
        </div>
        <CodeView
          content={generatedKeys?.secretKey ?? t("Loading ...")}
          className="mt-2"
        />
      </div>
      <div>
        <SubHeader title={t("Public Key")} />
        <CodeView
          content={generatedKeys?.publicKey ?? t("Loading ...")}
          className="mt-2"
        />
      </div>
      <div>
        <SubHeader title={t(".env")} />
        <CodeView content={envCode} className="mt-2" />
      </div>
    </div>
  );
};
