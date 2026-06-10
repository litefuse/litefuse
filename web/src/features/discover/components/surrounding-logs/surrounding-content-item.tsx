// @ts-nocheck
import { useAtom } from "jotai";
import { nanoid } from "nanoid";
import { isComplexType } from "utils/data";
import { IconButton } from "components/ui/icon-button";
import React from "react";
import { css } from "@emotion/css";
import { surroundingDataFilterAtom } from "store/discover";

interface ContentItemProps {
  fieldName: string;
  fieldValue: string | number;
  fieldType: string;
}

export function SurroundingContentItem({
  fieldName,
  fieldValue,
  fieldType,
}: ContentItemProps) {
  const [surroundingDataFilter, setSurroundingDataFilter] = useAtom(
    surroundingDataFilterAtom,
  );
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
              setSurroundingDataFilter([
                ...surroundingDataFilter,
                { fieldName, operator: "=", value: [fieldValue], id: nanoid() },
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
                  value: [fieldValue],
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
