import { api } from "@/src/utils/api";
import { showSuccessToast } from "@/src/features/notifications/showSuccessToast";
import { showErrorToast } from "@/src/features/notifications/showErrorToast";
import { type DefaultViewScope } from "@langfuse/shared/src/server";

import { useTranslation } from "react-i18next";
interface UseDefaultViewMutationsProps {
  tableName: string;
  projectId: string;
}

export function useDefaultViewMutations({
  tableName,
  projectId,
}: UseDefaultViewMutationsProps) {
  const { t } = useTranslation();
  const utils = api.useUtils();

  const setAsDefault = api.TableViewPresets.setAsDefault.useMutation({
    onSuccess: (_, variables) => {
      utils.TableViewPresets.getDefault.invalidate({
        projectId,
        viewName: tableName,
      });
      utils.TableViewPresets.getDefaultAssignments.invalidate({
        projectId,
        viewName: tableName,
      });
      showSuccessToast({
        title: t("Default view set"),
        description:
          variables.scope === "user"
            ? t("Set as your default")
            : t("Set as project default"),
      });
    },
    onError: (error) => {
      showErrorToast(t("Failed to set default"), error.message);
    },
  });

  const clearDefault = api.TableViewPresets.clearDefault.useMutation({
    onSuccess: (_, variables) => {
      utils.TableViewPresets.getDefault.invalidate({
        projectId,
        viewName: tableName,
      });
      utils.TableViewPresets.getDefaultAssignments.invalidate({
        projectId,
        viewName: tableName,
      });
      showSuccessToast({
        title: t("Default cleared"),
        description:
          variables.scope === "user"
            ? t("Your default view cleared")
            : t("Project default view cleared"),
      });
    },
    onError: (error) => {
      showErrorToast(t("Failed to clear default"), error.message);
    },
  });

  const setViewAsDefault = (viewId: string, scope: DefaultViewScope) => {
    setAsDefault.mutate({
      projectId,
      viewId,
      viewName: tableName,
      scope,
    });
  };

  const clearViewDefault = (scope: DefaultViewScope) => {
    clearDefault.mutate({
      projectId,
      viewName: tableName,
      scope,
    });
  };

  return {
    setViewAsDefault,
    clearViewDefault,
    isSettingDefault: setAsDefault.isPending,
  };
}
