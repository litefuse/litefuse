import { Card } from "@/src/components/ui/card";

import { useTranslation } from "react-i18next";
export const NotFoundCard = ({
  itemType,
  singleLine = false,
}: {
  itemType: "trace" | "observation";
  singleLine?: boolean;
}) => {
  const { t } = useTranslation();
  if (singleLine) {
    return (
      <Card className="flex h-full w-full items-center justify-start overflow-hidden rounded-sm px-2">
        <p
          className="text-muted-foreground truncate text-xs"
          title={t(
            "The {{item}} is either still being processed or has been deleted.",
            { item: itemType },
          )}
        >
          {t(
            "The {{item}} is either still being processed or has been deleted.",
            { item: itemType },
          )}
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-sm p-3">
      <h2 className="mb-1.5 text-sm font-semibold">{t("Not found")}</h2>
      <p className="text-muted-foreground max-w-xs text-center text-xs">
        {t(
          "The {{item}} is either still being processed or has been deleted.",
          { item: itemType },
        )}
      </p>
    </Card>
  );
};
