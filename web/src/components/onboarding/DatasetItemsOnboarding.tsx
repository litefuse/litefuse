import { useState } from "react";
import { SplashScreen } from "@/src/components/ui/splash-screen";
import { Braces, Code, ListTree, Upload } from "lucide-react";
import DocPopup from "@/src/components/layouts/doc-popup";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/src/components/ui/dialog";
import { CsvUploadDialog } from "@/src/features/datasets/components/CsvUploadDialog";
import { NewDatasetItemForm } from "@/src/features/datasets/components/NewDatasetItemForm";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";
import { cn } from "@/src/utils/tailwind";

import { useTranslation } from "react-i18next";
interface DatasetItemEntryPointRowProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick?: () => void;
  hasAccess?: boolean;
  comingSoon?: boolean;
  docPopup?: {
    description: string;
    href: string;
  };
}

const DatasetItemEntryPointRow = ({
  icon,
  title,
  description,
  onClick,
  hasAccess = true,
  comingSoon = false,
  docPopup,
}: DatasetItemEntryPointRowProps) => {
  const { t } = useTranslation();
  const disabled = !hasAccess || comingSoon;
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "border-border flex h-20 items-center gap-4 rounded-lg border p-4 transition-colors",
        disabled
          ? "bg-muted text-muted-foreground opacity-60"
          : "bg-card hover:bg-accent/50 cursor-pointer",
      )}
      onClick={!disabled ? onClick : undefined}
      title={
        !hasAccess
          ? t(
              "You don't have access to this feature, please contact your administrator",
            )
          : undefined
      }
    >
      <div className="flex items-center">{icon}</div>
      <div className="flex flex-1 flex-col gap-1">
        <h3 className="font-semibold">{title}</h3>
        <div className="flex items-center gap-1">
          <p className="text-muted-foreground text-sm">{description}</p>
          {docPopup && (
            <DocPopup description={docPopup.description} href={docPopup.href} />
          )}
        </div>
      </div>
    </div>
  );
};

export const DatasetItemsOnboarding = ({
  projectId,
  datasetId,
}: {
  projectId: string;
  datasetId: string;
}) => {
  const { t } = useTranslation();
  const capture = usePostHogClientCapture();
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isNewItemDialogOpen, setIsNewItemDialogOpen] = useState(false);

  const hasProjectAccess = useHasProjectAccess({
    projectId,
    scope: "datasets:CUD",
  });

  return (
    <SplashScreen
      title={t("Add items to your dataset")}
      description={t(
        "Datasets are collections of specific edge cases and underrepresented patterns used to evaluate your application.",
      )}
    >
      <div className="flex flex-col gap-4">
        <CsvUploadDialog
          open={hasProjectAccess && isUploadDialogOpen}
          onOpenChange={setIsUploadDialogOpen}
          projectId={projectId}
          datasetId={datasetId}
        >
          <DialogTrigger asChild disabled={!hasProjectAccess}>
            <DatasetItemEntryPointRow
              icon={<Upload className="h-5 w-5" />}
              title={t("Upload CSV")}
              description={t("Import dataset items from a CSV file")}
              onClick={() => {
                if (hasProjectAccess) {
                  capture("dataset_item:upload_csv_button_click");
                }
              }}
              hasAccess={hasProjectAccess}
            />
          </DialogTrigger>
        </CsvUploadDialog>

        <Dialog
          open={hasProjectAccess && isNewItemDialogOpen}
          onOpenChange={setIsNewItemDialogOpen}
        >
          <DialogTrigger asChild disabled={!hasProjectAccess}>
            <DatasetItemEntryPointRow
              icon={<Braces className="h-5 w-5" />}
              title={t("Add Manually")}
              description={t("Manually input a single item")}
              onClick={() => {
                if (hasProjectAccess) {
                  capture("dataset_item:new_form_open");
                }
              }}
              hasAccess={hasProjectAccess}
            />
          </DialogTrigger>
          <DialogContent size="lg">
            <DialogHeader>
              <DialogTitle>{t("Create dataset item")}</DialogTitle>
            </DialogHeader>
            <NewDatasetItemForm
              projectId={projectId}
              datasetId={datasetId}
              onFormSuccess={() => setIsNewItemDialogOpen(false)}
              className="h-full overflow-y-auto"
            />
          </DialogContent>
        </Dialog>

        <Link
          href="https://litefuse.ai/docs/evaluation/experiments/datasets#create-items-from-production-data"
          target="_blank"
        >
          <DatasetItemEntryPointRow
            icon={<Code className="h-5 w-5" />}
            title={t("Add via Code")}
            description={t("Use our Python/TS/JS SDKs or custom API")}
          />
        </Link>

        <DatasetItemEntryPointRow
          icon={<ListTree className="h-5 w-5" />}
          title={t("Select Traces")}
          description={t("Coming soon!")}
          comingSoon
          docPopup={{
            description: t(
              "Creating items from production data is supported on single trace level. Click to view docs for more details.",
            ),
            href: "https://litefuse.ai/docs/evaluation/experiments/datasets#create-items-from-production-data",
          }}
        />
      </div>
    </SplashScreen>
  );
};
