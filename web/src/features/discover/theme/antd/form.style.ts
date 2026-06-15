// @ts-nocheck
import { css } from "@emotion/css";

export const FormStyle = css`
  &:not(.ant-form-hide-required-mark) {
    .ant-form-item {
      .ant-form-item-label {
        > label {
          &.ant-form-item-required:not(.ant-form-item-required-mark-optional) {
            &::before {
              display: none;
            }
            &::after {
              display: inline-block;
              margin-right: 4px;
              color: #f25050;
              font-size: 14px;
              font-family: SimSun, sans-serif;
              line-height: 1;
              visibility: visible;
              content: "*";
            }
          }
        }
      }
    }
  }
  .ant-form-item {
    &.ant-form-item-has-error {
      input,
      button {
        border-color: hsl(var(--r4));
      }
    }
    .ant-form-item-explain-error {
      color: hsl(var(--r2));
    }
  }
`;
