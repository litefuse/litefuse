// @ts-nocheck
import { css } from "@emotion/css";
import React from "react";

const discoverHeaderSearchClass = css`
  flex: 2;
  display: flex;
  border-radius: 6px;
  align-items: center;
  margin-right: 8px;
  .ant-select-open {
    .ant-select-arrow {
      .anticon {
        transform: rotate(-180deg);
      }
    }
  }
  .select-database {
    width: 160px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .ant-select-single {
    height: 30px;
  }
`;

export function DiscoverHeaderSearch({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return React.createElement(
    "div",
    { className: `${discoverHeaderSearchClass} ${className ?? ""}` },
    children,
  );
}

const discoverHeaderTimeSelectClass = css`
  flex: 1;
  display: flex;
  border-radius: 6px;
  align-items: center;
  margin-right: 8px;

  div.trp-time-label {
    border: 0px;
  }
`;

export function DiscoverHeaderTimeSelect({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return React.createElement(
    "div",
    { className: `${discoverHeaderTimeSelectClass} ${className ?? ""}` },
    children,
  );
}

export const CascaderStyle = css`
  width: 184px;
  .ant-select-selector {
    padding: 0 16px 0 40px !important;
  }
  .ant-select-selection-placeholder,
  .ant-select-selection-item {
    margin-top: 2px;
  }
  .ant-select-selector
    > .ant-select-selection-search
    > .ant-select-selection-search-input {
    margin-left: 1.8rem;
  }
`;
