// @ts-nocheck
import { css } from "@emotion/css";

export const TreeSelectStyle = css`
  height: 36px;
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
    .anticon {
      pointer-events: none !important;
    }
  }
  &.ant-select-multiple .ant-select-selection-placeholder {
    left: 12px;
    right: 12px;
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
        border-color: hsl(var(--b3)) !important;
      }
    }
  }
  &.light.ant-tree-select:not(.ant-select-customize-input):not(
      .ant-select-status-error
    ) {
    &:hover,
    &.ant-select-focused {
      .ant-select-selector {
        border-color: hsl(var(--b7)) !important;
      }
    }
    .ant-select-selector {
      .ant-select-selection-overflow-item {
        .ant-select-selection-item {
          color: hsl(var(--n3));
          background-color: hsla(var(--b1) / 0.6);
        }
      }
    }
  }
`;

export const TreeSelectPopupStyle = css`
  border: 1px solid hsl(var(--n7));
  background: hsla(var(--n7) / 0.6);
  backdrop-filter: blur(12px);
  .ant-select-tree {
    background: transparent;
    .ant-cascader-menu {
      padding: 8px 0;

      li.ant-cascader-menu-item {
        margin: 0 8px;
        color: hsl(var(--n3));
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
    .ant-select-tree-switcher {
      line-height: 22px;
      .ant-select-tree-switcher-icon {
        font-size: 14px;
      }
    }
    .ant-select-tree-node-content-wrapper {
      overflow: hidden;
      .ant-select-tree-title {
        text-overflow: ellipsis;
        overflow: hidden;
        display: block;
      }
    }
    .ant-select-tree-checkbox-checked {
      .ant-select-tree-checkbox-inner {
        &: after {
          border-width: 1px;
        }
      }
    }
  }
  &.light.ant-select-dropdown {
    background-color: hsla(var(--n8));
    .ant-select-tree {
      .ant-select-tree-treenode-leaf-last {
        .ant-select-tree-switcher {
          &:hover {
            background-color: hsla(var(--b1) / 1);
            border-radius: 4px;
          }
          &:hover:before {
            background-color: hsla(var(--b8) / 0);
          }
        }
      }
    }
    .ant-select-tree-checkbox {
      .ant-select-tree-checkbox-inner {
        background-color: hsl(var(--n8));
        border-color: hsl(var(--n6));
      }
    }
    .ant-select-tree-checkbox-checked {
      .ant-select-tree-checkbox-inner {
        background-color: hsl(var(--b6));
        border-color: hsl(var(--b6));
        color: hsl(var(--n8));
      }
    }
  }
`;
