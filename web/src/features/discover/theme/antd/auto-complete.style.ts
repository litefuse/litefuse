// @ts-nocheck
import { css } from "@emotion/css";

export const AutoCompletePopupStyle = css`
  border: 1px solid hsl(var(--n7));
  background-color: hsl(var(--n7) / 0.6);
  backdrop-filter: blur(12px);
  padding: 8px 0;
  pointer-events: auto !important;
  .ant-select {
    height: auto;
  }
  .ant-select-item-option {
    color: hsl(var(--n3));
  }
  .rc-virtual-list-holder-inner {
    padding: 0 8px;
    .ant-select-item-option-active:not(.ant-select-item-option-disabled) {
      background-color: hsl(var(--n6) / 0.8);
    }
  }
  .rc-virtual-list-scrollbar {
    .rc-virtual-list-scrollbar-thumb {
      background-color: transparent !important;
      border-radius: 4px !important;
    }
  }
  &:hover {
    .rc-virtual-list-scrollbar-thumb {
      background-color: hsl(var(--n7)) !important;
    }
  }
  &.light {
    border: 1px solid hsl(var(--n9));
    background-color: hsla(var(--n8) / 0.6);
    backdrop-filter: blur(24px);
    .rc-virtual-list-holder-inner {
      padding: 0 8px;
      .ant-select-item-option-active:not(.ant-select-item-option-disabled) {
        background-color: hsla(var(--b1) / 0.8);
      }
    }
  }
`;
