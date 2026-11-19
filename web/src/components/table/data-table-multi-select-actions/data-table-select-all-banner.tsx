import { type MultiSelect } from "@/src/components/table/data-table-toolbar";
import { Button } from "@/src/components/ui/button";
import { numberFormatter } from "@/src/utils/numbers";
import { Trans, useTranslation } from "react-i18next";

export function DataTableSelectAllBanner({
  selectAll,
  setSelectAll,
  setRowSelection,
  pageSize,
  totalCount,
}: MultiSelect) {
  const { t } = useTranslation();
  const totalPages = totalCount ? Math.ceil(totalCount / pageSize) : 0;

  return (
    <div className="bg-input @container mb-2 flex flex-wrap items-center justify-center gap-2 rounded-sm p-2">
      {selectAll ? (
        <span className="text-sm">
          <Trans
            i18nKey="All <0>{{total}}</0> items are selected."
            values={{ total: numberFormatter(totalCount ?? 0, 0) }}
            components={[<span className="font-semibold" key="total" />]}
          />{" "}
          <Button
            variant="ghost"
            className="text-accent-dark-blue hover:text-accent-dark-blue/80 h-auto p-0 font-semibold"
            onClick={() => {
              setSelectAll(false);
              setRowSelection({});
            }}
          >
            {t("Clear selection")}
          </Button>
        </span>
      ) : (
        <span className="text-sm">
          <Trans
            i18nKey="All <0>{{pageSize}}</0> items on this page are selected."
            values={{ pageSize }}
            components={[<span className="font-semibold" key="pageSize" />]}
          />{" "}
          <Button
            variant="ghost"
            className="text-accent-dark-blue hover:text-accent-dark-blue/80 h-auto p-0 font-semibold"
            onClick={() => {
              setSelectAll(true);
            }}
          >
            {t("Select all {{total}} items across {{pages}} pages", {
              total: numberFormatter(totalCount ?? 0, 0),
              pages: numberFormatter(totalPages, 0),
            })}
          </Button>
        </span>
      )}
    </div>
  );
}
