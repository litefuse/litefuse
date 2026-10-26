/* eslint-disable no-nested-ternary */
import { useTranslation } from "react-i18next";

import { Badge } from "@/src/components/ui/badge";
import { V4MigrationBadgeContent } from "@/src/features/v4-migration/V4MigrationBadgeContent";

export function RuleNameCell({
  name,
  legacy,
  onUpgrade,
}: {
  name: string;
  legacy: boolean;
  onUpgrade?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="block truncate font-bold" title={name}>
        {name}
      </span>
      {legacy ? (
        onUpgrade ? (
          <span onClick={(event) => event.stopPropagation()}>
            <V4MigrationBadgeContent
              onClick={onUpgrade}
              title={t("Upgrade now")}
              showChevron={false}
              compact
            />
          </span>
        ) : (
          <Badge variant="warning">{t("Legacy")}</Badge>
        )
      ) : null}
    </div>
  );
}
