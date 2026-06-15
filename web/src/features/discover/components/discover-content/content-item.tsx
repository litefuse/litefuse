// @ts-nocheck
import { useAtom } from "jotai";
import { css } from "@emotion/css";
import { nanoid } from "nanoid";
import { dataFilterAtom } from "store/discover";
import React from "react";
import { isComplexType, isValidTimeFieldType } from "utils/data";
import { IconButton } from "components/ui/icon-button";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc);

interface ContentItemProps {
  fieldName: string;
  fieldValue: string | number;
  fieldType: string;
}

export function ContentItem({
  fieldName,
  fieldValue,
  fieldType,
}: ContentItemProps) {
  const [dataFilter, setDataFilter] = useAtom(dataFilterAtom);

  const filterValue = (() => {
    const raw =
      typeof fieldValue === "object" ? JSON.stringify(fieldValue) : fieldValue;
    if (
      typeof raw === "string" &&
      isValidTimeFieldType(fieldType?.toUpperCase())
    ) {
      const d = dayjs.utc(raw);
      if (d.isValid()) {
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
    <div>
      {!isComplexType(fieldType) && (
        <div
          className={css`
            display: flex;
            alignitems: "center";
            margin-left: 10px;
          `}
        >
          <IconButton
            name="plus-circle"
            onClick={(e) => {
              setDataFilter([
                ...dataFilter,
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
              setDataFilter([
                ...dataFilter,
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
  );
}
