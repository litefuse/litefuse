// @ts-nocheck
import { useAtom, useAtomValue } from "jotai";
import { nanoid } from "nanoid";
import { IconButton } from "components/ui/icon-button";
import React from "react";
import { surroundingDataFilterAtom, tableFieldsAtom } from "store/discover";
import { isComplexType, isValidTimeFieldType } from "utils/data";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc);
import { css } from "@emotion/css";

export function SurroundingContentTableActions({ fieldName, fieldValue }: any) {
  console.log(fieldName, fieldValue);
  // const [selectedSurroundingFields, setSelectedSurroundingFields] = useAtom(surroundingSelectedFieldsAtom);
  const [surroundingDataFilter, setSurroundingDataFilter] = useAtom(
    surroundingDataFilterAtom,
  );
  const tableFields = useAtomValue(tableFieldsAtom);
  const fieldType = tableFields.find((field) => field.Field === fieldName).Type;
  const filterValue = (() => {
    const raw =
      typeof fieldValue === "object" ? JSON.stringify(fieldValue) : fieldValue;
    if (
      typeof raw === "string" &&
      isValidTimeFieldType(fieldType?.toUpperCase())
    ) {
      const d = dayjs.utc(raw);
      if (d.isValid()) {
        // Strip trailing non-digit chars (e.g. 'Z' in ISO strings like '360Z')
        const rawMs = raw.includes(".") ? raw.split(".")[1] : null;
        const msPart = rawMs ? rawMs.replace(/\D+$/, "") : null;
        const fmt = msPart
          ? `YYYY-MM-DD HH:mm:ss.${"S".repeat(msPart.length)}`
          : "YYYY-MM-DD HH:mm:ss";
        return d.utc().format(fmt);
      }
    }
    return raw;
  })();
  return (
    <>
      <div
        className="icons"
        style={{ display: "flex", justifyContent: "flex-end" }}
      >
        {!isComplexType(fieldType) && (
          <div
            className={css`
              display: flex;
              align-items: "center";
              margin-left: 10px;
            `}
          >
            <IconButton
              name="plus-circle"
              onClick={(e) => {
                setSurroundingDataFilter([
                  ...surroundingDataFilter,
                  {
                    fieldName,
                    operator: "=",
                    value: [filterValue],
                    id: nanoid(),
                  },
                ]);
                e.stopPropagation();
              }}
              tooltip="Equivalent filtration"
            />
            <IconButton
              name="minus-circle"
              style={{ marginLeft: "4px" }}
              onClick={(e) => {
                setSurroundingDataFilter([
                  ...surroundingDataFilter,
                  {
                    fieldName,
                    operator: "!=",
                    value: [filterValue],
                    id: nanoid(),
                  },
                ]);
                e.stopPropagation();
              }}
              tooltip="Nonequivalent filtration"
            />
          </div>
        )}
      </div>
    </>
  );
}
