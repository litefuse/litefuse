// @ts-nocheck
"use client";

import React, { JSX } from "react";
import { ConfigProvider, ThemeConfig } from "antd";

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
