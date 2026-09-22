import { Button } from "@/src/components/ui/button";
import { api } from "@/src/utils/api";
import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/src/components/ui/popover";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { useTranslation } from "react-i18next";
export function RetryBackgroundMigration({
  backgroundMigrationName,
  isRetryable,
}: {
  backgroundMigrationName: string;
  isRetryable: boolean;
}) {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const [isOpen, setIsOpen] = useState(false);
  const [adminApiKey, setAdminApiKey] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const mutRetryBackgroundMigration =
    api.backgroundMigrations.retry.useMutation({
      onSuccess: () => {
        void utils.backgroundMigrations.invalidate();
        toast.success(t("Migration scheduled for retry"));
        setIsOpen(false);
        setAdminApiKey("");
      },
      onError: (error) => {
        toast.error(error?.message || t("Failed to retry migration"));
      },
      onSettled: () => {
        setIsLoading(false);
      },
    });

  const handleRetry = async () => {
    if (!adminApiKey.trim()) {
      toast.error(t("Admin API key is required"));
      return;
    }
    setIsLoading(true);
    try {
      await mutRetryBackgroundMigration.mutateAsync({
        name: backgroundMigrationName,
        adminApiKey: "Bearer " + adminApiKey.trim(),
      });
    } catch (_e) {
      // Error handled in onError
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={() => setIsOpen((prev) => !prev)}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" disabled={!isRetryable}>
          <RotateCcw className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <h2 className="text-md mb-3 font-semibold">
          {t("Retry Background Migration")}
        </h2>
        <p className="mb-4 text-sm">
          {t(
            "This action schedules the migration for retry. Restart the worker containers to re-initiate the migration.",
          )}
        </p>

        <div className="mb-4">
          <Label htmlFor="admin-api-key" className="text-sm font-medium">
            {t("Admin API Key")}
          </Label>
          <Input
            id="admin-api-key"
            type="password"
            placeholder={t("Enter admin API key")}
            value={adminApiKey}
            onChange={(e) => setAdminApiKey(e.target.value)}
            className="mt-1"
            disabled={isLoading}
            autoComplete="off"
            inputMode="text"
            name="admin-api-key"
          />
          <p className="text-muted-foreground mt-1 text-xs">
            {t(
              "Required for security. This key must match your ADMIN_API_KEY environment variable",
            )}
            {" ("}
            <a
              href="https://litefuse.ai/self-hosting/administration/organization-management-api#authentication"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-primary underline"
            >
              {t("Docs")}
            </a>
            {")."}
          </p>
        </div>

        <div className="flex justify-end space-x-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setIsOpen(false);
              setAdminApiKey("");
            }}
            disabled={isLoading}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            variant="default"
            loading={isLoading}
            onClick={handleRetry}
            disabled={isLoading}
          >
            {t("Retry Migration")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
