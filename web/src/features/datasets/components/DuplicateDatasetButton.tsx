import { useRouter } from "next/router";
import { Button } from "@/src/components/ui/button";
import { api } from "@/src/utils/api";
import { Copy } from "lucide-react";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";

import { useTranslation } from "react-i18next";
export const DuplicateDatasetButton: React.FC<{
  projectId: string;
  datasetId: string;
}> = ({ projectId, datasetId }) => {
  const { t } = useTranslation();
  const router = useRouter();
  const hasAccess = useHasProjectAccess({
    projectId,
    scope: "datasets:CUD",
  });
  const duplicateDataset = api.datasets.duplicateDataset.useMutation({
    onSuccess: ({ id }) => {
      router.push(`/project/${projectId}/datasets/${id}`);
    },
  });

  const handleDuplicate = () => {
    if (
      confirm(
        t(
          "Are you sure you want to duplicate this dataset and all of its items?",
        ),
      )
    ) {
      duplicateDataset.mutate({ projectId, datasetId });
    }
  };

  return (
    <Button
      onClick={handleDuplicate}
      variant="ghost"
      title={t("Duplicate dataset")}
      loading={duplicateDataset.isPending}
      disabled={!hasAccess}
    >
      <Copy className="mr-2 h-4 w-4" />
      {t("Duplicate")}
    </Button>
  );
};
