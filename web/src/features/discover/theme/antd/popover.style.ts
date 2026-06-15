// @ts-nocheck
import { css } from "@emotion/css";

export const PopoverStyle = css`
  .ant-popover-arrow {
    bottom: 1px !important;
    &:before {
      backdrop-filter: blur(16px);
    }
    &:after {
      border-bottom: 1px solid hsl(var(--n7));
      border-right: 1px solid hsl(var(--n7));
    }
  }

  .ant-popover-inner {
    border-radius: 4px;
    border: 1px solid hsl(var(--n7));
    background: hsla(var(--n7) / 0.6);
    backdrop-filter: blur(16px);
  }
  &.light.ant-popover {
    .ant-popover-inner {
      background-color: hsla(var(--n8) / 0.6);
      border: 1px solid hsl(var(--n9));
      .ant-popconfirm-buttons {
        .ant-btn.ant-btn-default {
          background-color: hsla(var(--n7) / 0.6);
          &:hover {
            background-color: hsla(var(--n7) / 0.8);
          }
        }
        .ant-btn.ant-btn-dangerous {
          background-color: hsl(var(--r1));
          color: hsl(var(--n8));
          &:hover {
            background-color: hsl(var(--r2));
          }
        }
      }
    }
  }
`;
