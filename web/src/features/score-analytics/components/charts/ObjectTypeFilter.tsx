import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { type ObjectType } from "@/src/features/score-analytics/lib/analytics-url-state";

import { useTranslation } from "react-i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";
const OBJECT_TYPE_OPTIONS: Array<{ value: ObjectType; label: string }> = [
  { value: "all", label: i18nKey("All Objects") },
  { value: "trace", label: i18nKey("Traces") },
  { value: "session", label: i18nKey("Sessions") },
  { value: "observation", label: i18nKey("Observations") },
  { value: "dataset_run", label: i18nKey("Dataset Runs") },
];

interface ObjectTypeFilterProps {
  value: ObjectType;
  onChange: (value: ObjectType) => void;
  className?: string;
}

export function ObjectTypeFilter({
  value,
  onChange,
  className,
}: ObjectTypeFilterProps) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className} aria-label={t("Object type")}>
        <SelectValue placeholder={t("Object type")} />
      </SelectTrigger>
      <SelectContent>
        {OBJECT_TYPE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {t(option.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
