// @ts-nocheck
import { Icon } from "components/ui/icon";
import React from "react";

export const FIELD_TYPES = [
  {
    key: "STRING",
    value: ["VARCHAR", "STRING", "CHAR", "TEXT"],
    icon: <Icon name="text-fields" />,
  },
  {
    key: "NUMBER",
    value: [
      "INT",
      "LARGEINT",
      "SMALLINT",
      "TINYINT",
      "DECIMAL",
      "BIGINT",
      "FLOAT",
      "DOUBLE",
    ],
    icon: <Icon name="percentage" />,
  },
  {
    key: "DATE",
    value: ["DATE", "DATETIME", "DATEV2", "DATETIMEV2"],
    icon: <Icon name="clock-nine" />,
  },
  {
    key: "JSONB",
    value: ["JSONB"],
    icon: <Icon name="brackets-curly" />,
    complex: true,
  },
  {
    key: "ARRAY",
    value: ["ARRAY"],
    icon: <Icon name="list-ul" />,
    complex: true,
  },
  {
    key: "BOOLEAN",
    value: ["BOOLEAN"],
    icon: <Icon name="toggle-on" />,
  },
  {
    key: "BITMAP",
    value: ["BITMAP"],
    icon: <Icon name="building" />,
    complex: true,
  },
  {
    key: "HLL",
    value: ["HLL"],
    icon: <Icon name="draggabledots" />,
    complex: true,
  },
  {
    key: "VARIANT",
    value: ["VARIANT"],
    icon: <Icon name="brackets-curly" />,
    complex: true,
  },
  {
    key: "JSON",
    value: ["JSON"],
    icon: <Icon name="brackets-curly" />,
    complex: true,
  },
];

export const getFieldIcon = (columnType: string) => {
  const currentColumnType = FIELD_TYPES.find((item) =>
    item.value.some((val) => columnType.toLocaleUpperCase().includes(val)),
  );
  return currentColumnType?.icon;
};
