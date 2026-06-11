// @ts-nocheck
import { css } from "@emotion/css";
import React from "react";

export const HoverStyle = css`
  &:hover {
    .filter-content {
      visibility: visible;
    }
  }
`;

const columnStyleWrapperBase = css`
  .field-key {
    padding: 0px 4px 2px;
    margin-right: 4px;
    border-radius: 4px;
  }
`;

export function ColumnStyleWrapper({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return React.createElement(
    "div",
    { className: `${columnStyleWrapperBase} ${className ?? ""}` },
    children,
  );
}
