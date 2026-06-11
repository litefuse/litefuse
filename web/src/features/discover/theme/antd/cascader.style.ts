// @ts-nocheck
import { css } from "@emotion/css";

export const AntdCascaderStyle = css`
  height: 32px;
  &.ant-select-single:not(.ant-select-customize-input) .ant-select-selector {
    padding-left: 16px;
    padding-right: 10px;
  }
  .ant-select-selector {
    box-shadow: none !important;
    background-color: transparent !important;
  }
  .ant-select-arrow {
    width: 28px;
    justify-content: center;
    color: hsl(var(--n6));
    .anticon {
      pointer-events: none !important;
    }
  }
  &.ant-select-outlined:not(.ant-select-customize-input):not(
      .ant-select-status-error
    ) {
    .ant-select-selector {
      border-color: hsl(var(--n7));
    }
    &:hover,
    &.ant-select-focused {
      .ant-select-selector {
        border-color: hsl(var(--b3));
      }
    }
  }
  &.ant-select-show-search.ant-select:not(.ant-select-customize-input) {
    .ant-select-selector {
      input {
        color: hsl(var(--n2));
      }
    }
  }
  &.light {
    .ant-select-selector {
      .ant-select-selection-item {
        color: hsl(var(--n2));
      }
    }
    &.ant-select-outlined:not(.ant-select-customize-input):not(
        .ant-select-status-error
      ) {
      &:hover,
      &.ant-select-focused {
        .ant-select-selector {
          border-color: hsl(var(--b7));
        }
      }
    }
  }
`;

export const CascaderPopupStyle = css`
  border: 1px solid hsl(var(--n7));
  background: hsla(var(--n7) / 0.6);
  backdrop-filter: blur(12px);
  .ant-cascader-menus {
    padding: 0;
    .ant-cascader-menu {
      padding: 8px 0;

      li.ant-cascader-menu-item {
        max-width: 300px;
        margin: 0 8px;
        color: hsl(var(--n3));
        .ant-cascader-menu-item-content {
          text-overflow: ellipsis;
          overflow: hidden;
        }
      }

      li.ant-cascader-menu-item-active {
        color: hsl(var(--b3));
        font-weight: 400;
        background-color: transparent;
        .ant-cascader-menu-item-expand-icon > span {
          color: hsl(var(--b3));
        }
      }
    }
  }
  &.light {
    border: 1px solid hsl(var(--n9));
    background: hsla(var(--n8) / 0.6);
    .ant-cascader-menus {
      li.ant-cascader-menu-item {
        color: hsl(var(--n3));
        &:not(.ant-cascader-menu-item-active) {
          &:hover {
            background: hsla(var(--b1) / 0.8);
          }
        }
      }
      li.ant-cascader-menu-item-active {
        color: hsl(var(--b7));
        .ant-cascader-menu-item-expand-icon > span {
          color: hsl(var(--b7));
        }
      }
    }
  }
`;
