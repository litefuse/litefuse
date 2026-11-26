// @ts-nocheck
"use client";

import React, { type JSX } from "react";
import { ConfigProvider, type ThemeConfig } from "antd";

const withTheme = (node: JSX.Element | React.ReactNode, theme: ThemeConfig) => (
  <>
    <ConfigProvider
      componentSize="middle"
      theme={{
        ...theme,
        hashed: false,
      }}
    >
      {node}
    </ConfigProvider>
  </>
);

export default withTheme;
