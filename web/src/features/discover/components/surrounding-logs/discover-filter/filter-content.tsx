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
  tableFieldsAtom,
  tableFieldValuesAtom,
  surroundingDataFilterAtom,
} from "store/discover";
import { OPERATORS } from "utils/data";
import { FilterContentProps } from "../types";
import { cn } from "@/src/utils/tailwind";

type FilterFormValues = {
  field: string;
  operator: string;
  valueText: string;
  minValue: string;
  maxValue: string;
  label: string;
  showLabel: boolean;
};

export function FilterContent({ onHide, dataFilterValue }: FilterContentProps) {
  const [surroundingDataFilter, setSurroundingDataFilter] = useAtom(
    surroundingDataFilterAtom,
  );
  const tableFields = useAtomValue(tableFieldsAtom);
  const tableFieldValue = useAtomValue(tableFieldValuesAtom);

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

  const operator = watch("operator");
  const showLabel = watch("showLabel");

  const onSubmit = (formValues: FilterFormValues) => {
    const current = surroundingDataFilter.find(
      (f) => f.id === dataFilterValue?.id,
    );
    const id = dataFilterValue?.id || nanoid();
    const newItem = {
      id,
      fieldName: formValues.field,
      operator: formValues.operator,
      label: formValues.showLabel ? formValues.label : "",
      value: getFilterValue(formValues),
    };

    const nextFilters = current
      ? surroundingDataFilter.map((f) => (f.id === id ? newItem : f))
      : [...surroundingDataFilter, newItem];

    setSurroundingDataFilter(nextFilters);
    onHide();
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-80 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Column" error={errors.field?.message}>
          <Controller
            name="field"
            control={control}
            rules={{ required: "Please select a field" }}
            render={({ field }) => (
              <NativeSelect
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
                placeholder="Select a field"
              >
                {tableFields.map((f) => (
                  <option key={f.Field} value={f.Field}>
                    {f.Field}
                  </option>
                ))}
              </NativeSelect>
            )}
          />
        </FormField>

        <FormField label="Condition" error={errors.operator?.message}>
          <Controller
            name="operator"
            control={control}
            rules={{ required: "Please select an operator" }}
            render={({ field }) => (
              <NativeSelect
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
                placeholder="Select an operator"
              >
                {OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </NativeSelect>
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
        <Button
          variant="outline"
          onClick={(e) => {
            e.preventDefault();
            onHide();
          }}
        >
          Cancel
        </Button>
        <Button type="submit">Apply filter</Button>
      </div>
    </form>
  );
}

function NativeSelect({
  value,
  onChange,
  placeholder,
  children,
  className,
}: {
  value: string;
  onChange: React.ChangeEventHandler<HTMLSelectElement>;
  placeholder?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={onChange}
      className={cn(
        "border-input bg-background text-foreground h-10 w-full rounded-md border px-3 py-2 text-sm",
        !value && "text-muted-foreground",
        className,
      )}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {children}
    </select>
  );
}

function renderValueField({
  operator,
  errors,
  register,
  suggestions,
}: {
  operator: string;
  errors: any;
  register: any;
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

  if (!operator) {
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
        list="surrounding-field-value-list"
        placeholder={
          operator === "in" || operator === "not in"
            ? "value-a, value-b"
            : "Enter a value"
        }
        {...register("valueText", { required: "Please enter a value" })}
      />
      <datalist id="surrounding-field-value-list">
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

function getDefaultValueText(dataFilterValue?: any) {
  if (!dataFilterValue?.value?.length) return "";

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
