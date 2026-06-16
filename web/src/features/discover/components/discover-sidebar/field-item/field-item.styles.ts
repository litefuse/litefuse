// @ts-nocheck
import { css } from "@emotion/css";

export const DiscoverTreeStyle = css`
  .ant-tree-title {
    font-size: 14px;
    color: hsl(var(--n4));
    font-weight: 500;
  }
  .ant-tree-icon__customize {
    width: 14px !important;
    margin-right: 0.5rem;
  }
  .ant-tree-node-content-wrapper-normal {
    margin-left: 22px;
  }
  .ant-tree-node-content-wrapper {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .ant-tree-title {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 600px;
    marigin-right: 20px;
  }
`;
