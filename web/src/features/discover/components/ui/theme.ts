// @ts-nocheck
"use client";

import { useTheme } from "next-themes";

export type DiscoverTheme = {
  isDark: boolean;
  isLight: boolean;
  colors: {
    text: {
      primary: string;
      secondary: string;
      disabled: string;
    };
    background: {
      primary: string;
      secondary: string;
      canvas: string;
    };
    border: {
      weak: string;
      medium: string;
      strong: string;
    };
    primary: {
      main: string;
      text: string;
      border: string;
      shade: string;
      transparent: string;
      contrastText: string;
      name: string;
      main2: string;
    };
  };
  shape: {
    borderRadius: (n?: number) => string;
  };
  spacing: (...args: number[]) => string;
  shadows: {
    z0: string;
    z1: string;
    z2: string;
    z3: string;
  };
  typography: {
    fontFamily: string;
    fontSize: string;
    fontWeightLight: number;
    fontWeightRegular: number;
    fontWeightMedium: number;
    fontWeightBold: number;
    size: {
      xs: string;
      sm: string;
      md: string;
      lg: string;
      xl: string;
      xxl: string;
    };
    h1: { fontSize: string; fontWeight: number; size: string };
    h2: { fontSize: string; fontWeight: number; size: string };
    h3: { fontSize: string; fontWeight: number; size: string };
    h4: { fontSize: string; fontWeight: number; size: string };
    h5: { fontSize: string; fontWeight: number; size: string };
    h6: { fontSize: string; fontWeight: number; size: string };
    body: { fontSize: string; fontWeight: number; size: string };
    bodySmall: { fontSize: string; fontWeight: number; size: string };
    code: { fontSize: string; fontFamily: string; size: string };
  };
};

export function useDiscoverTheme(): DiscoverTheme {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return {
    isDark,
    isLight: !isDark,
    colors: {
      text: {
        primary: isDark ? "#EFEFF0" : "#1F1F26",
        secondary: isDark ? "#9F9FA2" : "#5F5F64",
        disabled: isDark ? "#5F5F64" : "#9F9FA2",
      },
      background: {
        primary: isDark ? "#111217" : "#F4F5F5",
        secondary: isDark ? "#181B1F" : "#FAFAFA",
        canvas: isDark ? "#111217" : "#F4F5F5",
      },
      border: {
        weak: isDark ? "#3F3F45" : "#DFDFE0",
        medium: isDark ? "#5F5F64" : "#BFBFC1",
        strong: isDark ? "#9F9FA2" : "#8E8E8F",
      },
      primary: {
        main: isDark ? "#608DFF" : "#3D71FF",
        text: isDark ? "#608DFF" : "#3D71FF",
        border: isDark ? "#3D71FF" : "#608DFF",
        shade: isDark ? "#2C5AE0" : "#5278F5",
        transparent: isDark ? "rgba(96,141,255,0.15)" : "rgba(61,113,255,0.15)",
        contrastText: "#FFFFFF",
        name: "primary",
        main2: isDark ? "#608DFF" : "#3D71FF",
      },
    },
    shape: {
      borderRadius: (n?: number) => `${(n ?? 1) * 4}px`,
    },
    spacing: (...args: number[]) => {
      if (args.length === 0) {
        return "8px";
      }

      return args.map((n) => `${n * 8}px`).join(" ");
    },
    shadows: {
      z0: "none",
      z1: isDark ? "0 1px 3px rgba(0,0,0,0.4)" : "0 1px 3px rgba(0,0,0,0.2)",
      z2: isDark ? "0 4px 8px rgba(0,0,0,0.5)" : "0 4px 8px rgba(0,0,0,0.25)",
      z3: isDark
        ? "0 13px 20px rgba(0,0,0,0.6)"
        : "0 13px 20px rgba(0,0,0,0.3)",
    },
    typography: {
      fontFamily: "inherit",
      fontSize: "14px",
      fontWeightLight: 300,
      fontWeightRegular: 400,
      fontWeightMedium: 500,
      fontWeightBold: 700,
      size: {
        xs: "10px",
        sm: "12px",
        md: "14px",
        lg: "18px",
        xl: "24px",
        xxl: "36px",
      },
      h1: { fontSize: "2rem", fontWeight: 700, size: "2rem" },
      h2: { fontSize: "1.5rem", fontWeight: 700, size: "1.5rem" },
      h3: { fontSize: "1.25rem", fontWeight: 600, size: "1.25rem" },
      h4: { fontSize: "1.125rem", fontWeight: 600, size: "1.125rem" },
      h5: { fontSize: "1rem", fontWeight: 600, size: "1rem" },
      h6: { fontSize: "0.875rem", fontWeight: 600, size: "0.875rem" },
      body: { fontSize: "0.875rem", fontWeight: 400, size: "0.875rem" },
      bodySmall: { fontSize: "0.75rem", fontWeight: 400, size: "0.75rem" },
      code: {
        fontSize: "0.8125rem",
        fontFamily: "monospace",
        size: "0.8125rem",
      },
    },
  };
}

export function useDiscoverStyles<T>(
  getStyles: (theme: DiscoverTheme) => T,
): T {
  const theme = useDiscoverTheme();
  return getStyles(theme);
}
