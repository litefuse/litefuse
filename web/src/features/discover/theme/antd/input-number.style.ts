// @ts-nocheck
import { css } from "@emotion/css";

export const InputNumberStyle = css`
  width: 100%;
  .ant-input-number-handler {
    &.ant-input-number-handler-up-disabled {
      .ant-input-number-handler-up-inner {
        color: hsl(var(--n7));
      }
    }
    &:not(.ant-input-number-handler-up-disabled) {
      &:hover {
        .ant-input-number-handler-up-inner {
          color: hsl(var(--b3));
        }
      }
      .ant-input-number-handler-up-inner {
        color: hsl(var(--n6));
      }
    }
    &.ant-input-number-handler-down-disabled {
      .ant-input-number-handler-down-inner {
        color: hsl(var(--n7));
      }
    }
    &:not(.ant-input-number-handler-down-disabled) {
      &:hover {
        .ant-input-number-handler-down-inner {
          color: hsl(var(--b3));
        }
      }
      .ant-input-number-handler-down-inner {
        color: hsl(var(--n6));
      }
    }
  }
  &.light.ant-input-number {
    border-color: hsl(var(--n7));
    .ant-input-number-handler-wrap {
      border-color: hsl(var(--n7));
      .ant-input-number-handler {
        &.ant-input-number-handler-down,
        &.ant-input-number-handler-up {
          &:not(.ant-input-number-handler-down-disabled) {
            border-color: hsl(var(--n7));
            &:hover {
              .ant-input-number-handler-down-inner {
                color: hsl(var(--b7));
              }
              .ant-input-number-handler-up-inner {
                color: hsl(var(--b7));
              }
            }
          }
        }
      }
    }
  }
`;
