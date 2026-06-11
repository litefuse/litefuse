// @ts-nocheck
import React from "react";
import { useAtom, useAtomValue } from "jotai";
import { Controller, useForm } from "react-hook-form";
import { nanoid } from "nanoid";
import { Button } from "@/src/components/ui/button";
import { Checkbox } from "@/src/components/ui/checkbox";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import {
  tableFieldsAtom,
  dataFilterAtom,
  tableFieldValuesAtom,
  locationAtom,
} from "store/discover";
import type { DataFilterType, Operator } from "types/type";
import { OPERATORS } from "utils/data";

type FilterFormValues = {
  field: string;
  operator: string;
  valueText: string;
  minValue: string;
  maxValue: string;
  label: string;
  showLabel: boolean;
};

export function FilterContent({
  onHide,
  dataFilterValue,
}: {
  onHide: () => void;
  dataFilterValue?: DataFilterType;
}) {
  const tableFields = useAtomValue(tableFieldsAtom);
  const tableFieldValue = useAtomValue(tableFieldValuesAtom);
  const [dataFilter, setDataFilter] = useAtom(dataFilterAtom);
  const [_loc, setLoc] = useAtom(locationAtom);

  const {
    control,
    handleSubmit,
    watch,
    register,
    formState: { errors },
  } = useForm<FilterFormValues>({
    defaultValues: {
      field: dataFilterValue?.fieldName ?? "",
      operator: dataFilterValue?.operator ?? "",
      valueText: getDefaultValueText(dataFilterValue),
      minValue: Array.isArray(dataFilterValue?.value)
        ? String(dataFilterValue?.value[0] ?? "")
        : "",
      maxValue: Array.isArray(dataFilterValue?.value)
        ? String(dataFilterValue?.value[1] ?? "")
        : "",
      label: dataFilterValue?.label ?? "",
      showLabel: !!dataFilterValue?.label,
    },
  });

  const operator = watch("operator") as Operator | "";
  const showLabel = watch("showLabel");

  const onSubmit = (formValues: FilterFormValues) => {
    const current = dataFilter.find((f) => f.id === dataFilterValue?.id);
    const id = dataFilterValue?.id || nanoid();
    const newItem: DataFilterType = {
      id,
      fieldName: formValues.field,
      operator: formValues.operator as Operator,
      label: formValues.showLabel ? formValues.label : "",
      value: getFilterValue(formValues),
    };

    const nextFilters = current
      ? dataFilter.map((f) => (f.id === id ? newItem : f))
      : [...dataFilter, newItem];

    setDataFilter(nextFilters);
    setLoc((prev) => {
      const searchParams = prev.searchParams;
      searchParams?.set("data_filters", JSON.stringify(nextFilters));
      return {
        ...prev,
        searchParams,
      };
    });
    onHide();
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="border-border flex items-start justify-between border-b px-5 py-4">
        <div>
          <div className="text-sm font-semibold">Filter</div>
          <div className="text-muted-foreground mt-1 text-xs">
            Narrow the result set using a field, operator, and value.
          </div>
        </div>
      </div>

      <div className="space-y-4 px-5 pb-5">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Column" error={errors.field?.message}>
            <Controller
              name="field"
              control={control}
              rules={{ required: "Please select a field" }}
              render={({ field }) => (
                <Select
                  value={field.value || undefined}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder="Select a field" />
                  </SelectTrigger>
                  <SelectContent>
                    {tableFields.map((item) => (
                      <SelectItem key={item.Field} value={item.Field}>
                        {item.Field}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>

          <FormField label="Operator" error={errors.operator?.message}>
            <Controller
              name="operator"
              control={control}
              rules={{ required: "Please select an operator" }}
              render={({ field }) => (
                <Select
                  value={field.value || undefined}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder="Select an operator" />
                  </SelectTrigger>
                  <SelectContent>
                    {OPERATORS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
        </div>

        {renderValueField({
          operator,
          errors,
          register,
          suggestions: tableFieldValue.map((item) => item.value),
        })}

        <div className="flex items-center gap-3 rounded-md border border-dashed px-3 py-3">
          <Controller
            name="showLabel"
            control={control}
            render={({ field }) => (
              <Checkbox
                checked={!!field.value}
                onCheckedChange={(checked) => field.onChange(checked === true)}
              />
            )}
          />
          <div className="space-y-1">
            <Label className="text-sm font-medium">Custom label</Label>
            <p className="text-muted-foreground text-xs">
              Show a custom label on the filter chip.
            </p>
          </div>
        </div>

        {showLabel && (
          <FormField label="Chip label" error={errors.label?.message}>
            <Input
              className="h-10"
              placeholder="e.g. Error logs"
              {...register("label", { required: "Please enter label" })}
            />
          </FormField>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onHide}>
            Cancel
          </Button>
          <Button type="submit">Apply filter</Button>
        </div>
      </div>
    </form>
  );
}

function renderValueField({
  operator,
  errors,
  register,
  suggestions,
}: {
  operator: Operator | "";
  errors: Record<string, { message?: string } | undefined>;
  register: ReturnType<typeof useForm<FilterFormValues>>["register"];
  suggestions: string[];
}) {
  if (operator === "between" || operator === "not between") {
    return (
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Minimum value" error={errors.minValue?.message}>
          <Input
            className="h-10"
            placeholder="Start"
            {...register("minValue", { required: "Please enter min value" })}
          />
        </FormField>
        <FormField label="Maximum value" error={errors.maxValue?.message}>
          <Input
            className="h-10"
            placeholder="End"
            {...register("maxValue", { required: "Please enter max value" })}
          />
        </FormField>
      </div>
    );
  }

  if (operator === "is null" || operator === "is not null") {
    return null;
  }

  const helperText =
    operator === "in" || operator === "not in"
      ? "Use commas to enter multiple values."
      : undefined;

  return (
    <FormField
      label="Value"
      error={errors.valueText?.message}
      hint={helperText}
    >
      <Input
        className="h-10"
        list="discover-field-value-list"
        placeholder={
          operator === "in" || operator === "not in"
            ? "value-a, value-b"
            : "Enter a value"
        }
        {...register("valueText", { required: "Please enter a value" })}
      />
      <datalist id="discover-field-value-list">
        {suggestions.map((value, idx) => (
          <option key={`${value}-${idx}`} value={value} />
        ))}
      </datalist>
    </FormField>
  );
}

function FormField({
  label,
  error,
  hint,
  children,
}: React.PropsWithChildren<{
  label: string;
  error?: string;
  hint?: string;
}>) {
  return (
    <div className="space-y-2">
      <Label className="text-foreground/85 text-xs font-semibold tracking-wide">
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-destructive text-xs">{error}</p>
      ) : hint ? (
        <p className="text-muted-foreground text-xs">{hint}</p>
      ) : null}
    </div>
  );
}

function getDefaultValueText(dataFilterValue?: DataFilterType) {
  if (!dataFilterValue?.value?.length) {
    return "";
  }

  if (
    dataFilterValue.operator === "in" ||
    dataFilterValue.operator === "not in"
  ) {
    return dataFilterValue.value.join(", ");
  }

  return String(dataFilterValue.value[0] ?? "");
}

function getFilterValue(formValues: FilterFormValues): Array<string | number> {
  if (
    formValues.operator === "between" ||
    formValues.operator === "not between"
  ) {
    return [
      toTypedValue(formValues.minValue),
      toTypedValue(formValues.maxValue),
    ];
  }

  if (
    formValues.operator === "is null" ||
    formValues.operator === "is not null"
  ) {
    return [];
  }

  if (formValues.operator === "in" || formValues.operator === "not in") {
    return formValues.valueText
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map(toTypedValue);
  }

  if (formValues.operator === "like" || formValues.operator === "not like") {
    const v = formValues.valueText;
    const wrapped = v.includes("%") ? v : `%${v}%`;
    return [wrapped];
  }

  return [toTypedValue(formValues.valueText)];
}

function toTypedValue(value: string): string | number {
  return Number.isNaN(Number(value)) || value.trim() === ""
    ? value
    : Number(value);
}
