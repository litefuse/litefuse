// @ts-nocheck
import { css } from "@emotion/css";
import { PopoverStyle } from "./popover.style";

export const PopconfirmStyle = css`
  .ant-popover-inner {
    padding: 24px;
    max-width: 400px;
    .ant-popconfirm-message-icon {
      & > .anticon {
        font-size: 24px;
      }
    }
    .ant-popconfirm-message-text {
      .ant-popconfirm-title {
        font-size: 16px;
        font-weight: 500;
        line-height: 24px;
        color: hsl(var(--n1));
      }
      .ant-popconfirm-description {
        color: hsl(var(--n2));
        font-size: 14px;
        line-height: 22px;
        margin-top: 14px;
      }
    }
    .ant-popconfirm-buttons {
      margin-top: 14px;
      .ant-btn {
        padding: 5px 16px;
        height: auto;
        box-shadow: none;
        color: hsl(var(--n1));
        border-width: 0;
        &.ant-btn-default {
          background-color: hsla(var(--n6) / 0.6);
        }
        &.ant-btn-primary {
          background-color: hsl(var(--b4));
          color: hsl(var(--n2));
        }
        &.ant-btn-dangerous {
          background-color: hsl(var(--r2));
          color: hsl(var(--n2));
        }
      }
    }
  }
  ${PopoverStyle}
`;
