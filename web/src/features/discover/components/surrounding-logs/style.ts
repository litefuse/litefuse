// @ts-nocheck
import { css } from "@emotion/css";
import React from "react";

const surroundingLogsAutoCompleteWrapperClass = css`
  .ant-select {
    height: auto;
  }
`;

export function SurroundingLogsAutoCompleteWrapper({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return React.createElement(
    "div",
    {
      className: `${surroundingLogsAutoCompleteWrapperClass} ${className ?? ""}`,
    },
    children,
  );
}
