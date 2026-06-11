// @ts-nocheck
import { css } from "@emotion/css";

export const AntdSelectStyle = css`
  .ant-select-selector {
    border-color: hsl(var(--b3));
    box-shadow: none;
  }
  &:not(.ant-select-disabled):not(.ant-select-customize-input):not(
      .ant-pagination-size-changer
    ):hover,
  &.ant-select-focused.ant-select-outlined:not(.ant-select-disabled):not(
      .ant-select-customize-input
    ):not(.ant-pagination-size-changer) {
    .ant-select-selector {
      border-color: hsl(var(--b3));
      box-shadow: none;
    }
  }
  &.ant-select-single: not(.ant-select-customize-input) .ant-select-selector {
    padding: 0 8px 0 12px;
    color: hsl(var(--n2));
  }
  &.light {
    .ant-select-selector {
      border-color: hsl(var(--n7));
    }
  }
`;

export const AntdSelectPopupStyle = css`
  backdrop-filter: blur(12px);
  padding: 8px;
  &.ant-select-dropdown .ant-select-item {
    color: hsl(var(--n3));
    padding: 5px 8px;
    min-height: 32px;
  }
  &.ant-select-dropdown .ant-select-item-option-selected {
    background-color: transparent;
    color: hsl(var(--b3));
    font-weight: 400;
  }
  .rc-virtual-list-scrollbar {
    opacity: 0;
  }
  &.light {
    border: 1px solid hsl(var(--n9));
    background: hsla(var(--n8) / 0.6);
    .ant-select-item {
      color: hsl(var(--n3));
      &:not(.ant-select-item-option-selected):not(
          .ant-select-item-option-disabled
        ) {
        &:hover {
          background: hsla(var(--b1) / 0.8);
        }
      }
      &.ant-select-item-option-selected {
        color: hsl(var(--b7));
      }
    }
  }
`;
