// @ts-nocheck
import { IconButton } from "components/ui/icon-button";
import { useAtom, useAtomValue } from "jotai";
import { nanoid } from "nanoid";
import React from "react";
import {
  selectedFieldsAtom,
  dataFilterAtom,
  tableFieldsAtom,
} from "store/discover";
import { isComplexType, isValidTimeFieldType } from "utils/data";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc);

export function ContentTableActions({ fieldName, fieldValue }: any) {
  const [selectedFields, setSelectedFields] = useAtom(selectedFieldsAtom);
  const [dataFilter, setDataFilter] = useAtom(dataFilterAtom);
  const tableFields = useAtomValue(tableFieldsAtom);
  const fieldType = tableFields.find(
    (field) => field.Field === fieldName,
  )?.Type;
  const hasField = selectedFields.some((item: any) => item.Field === fieldName);
  const rawFilterValue =
    typeof fieldValue === "object" ? JSON.stringify(fieldValue) : fieldValue;
  const filterValue = (() => {
    if (
      typeof rawFilterValue === "string" &&
      isValidTimeFieldType(fieldType?.toUpperCase())
    ) {
      const d = dayjs.utc(rawFilterValue);
      if (d.isValid()) {
        // Strip trailing non-digit chars (e.g. 'Z' in ISO strings like '360Z')
        const rawMs = rawFilterValue.includes(".")
          ? rawFilterValue.split(".")[1]
          : null;
        const msPart = rawMs ? rawMs.replace(/\D+$/, "") : null;
        const fmt = msPart
          ? `YYYY-MM-DD HH:mm:ss.${"S".repeat(msPart.length)}`
          : "YYYY-MM-DD HH:mm:ss";
        return d.utc().format(fmt);
      }
    }
    return rawFilterValue;
  })();
  return (
    <>
      <div
        className="icons"
        style={{ display: "flex", justifyContent: "flex-end" }}
      >
        {!isComplexType(fieldType) && (
          <>
            <IconButton
              name="plus-circle"
              tooltip="Equivalent filtration"
              onClick={() => {
                setDataFilter([
                  ...dataFilter,
                  {
                    fieldName: fieldName,
                    operator: "=",
                    value: [filterValue],
                    id: nanoid(),
                  },
                ]);
              }}
            />
            <IconButton
              name="minus-circle"
              tooltip="Nonequivalent filtration"
              onClick={() => {
                setDataFilter([
                  ...dataFilter,
                  {
                    fieldName: fieldName,
                    operator: "!=",
                    value: [filterValue],
                    id: nanoid(),
                  },
                ]);
              }}
            />
          </>
        )}
        <IconButton
          name="plus"
          tooltip={hasField ? "Delete From Table" : "Add To Table"}
          onClick={() => {
            const field = tableFields.find(
              (field) => field.Field === fieldName,
            );
            if (hasField) {
              const index = selectedFields.findIndex(
                (item: any) => item.Field === fieldName,
              );
              selectedFields.splice(index, 1);
              setSelectedFields([...selectedFields]);
            } else {
              setSelectedFields([...selectedFields, field]);
            }
          }}
        />
      </div>
    </>
  );
}
