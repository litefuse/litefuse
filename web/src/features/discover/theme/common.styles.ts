// @ts-nocheck
import { css } from "@emotion/css";

export const CustomScrollbarStyle = css`
  &::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  &::-webkit-scrollbar-track {
    background-color: transparent;
    border-radius: 3px;
  }
  &::-webkit-scrollbar-thumb {
    background-color: transparent;
    border-radius: 3px;
  }
  &::-webkit-scrollbar-corner {
    background-color: transparent;
  }
  &:hover {
    &::-webkit-scrollbar-thumb {
      background-color: hsl(var(--n7));
    }
  }
  &::-webkit-scrollbar-thumb {
    &:hover {
      background-color: hsl(var(--n7));
    }
  }
`;
