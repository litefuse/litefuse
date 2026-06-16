// @ts-nocheck
import { css } from "@emotion/css";
import React from "react";

const discoverFilterWrapperClass = css`
  display: flex;
  align-items: center;
  .filter {
    align-self: flex-start;
    margin-top: 3px;
    margin-right: 8px;
    font-weight: 500;
    font-size: 14px;
    font-style: normal;
    line-height: 18px;
  }
  .filter-tag {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    row-gap: 8px;
    .tag {
      display: flex;
      align-items: center;
      max-width: 400px;
      height: 24px;
      padding: 2px 8px;
      font-weight: 400;
      font-size: 12px;
      font-style: normal;
      line-height: 18px;
      border: 0px;
      border-radius: 6px;
      .text {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
    }
  }
`;

export function DiscoverFilterWrapper({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return React.createElement(
    "div",
    { className: `${discoverFilterWrapperClass} ${className ?? ""}` },
    children,
  );
}

export const containerStyle = css`
  width: 320px;
`;

export const rowStyle = css`
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
`;

export const colStyle = css`
  flex: 1;
`;

export const footerStyle = css`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
`;
